package xyz.speakeasyapp.app.voicefilter.dsp

import xyz.speakeasyapp.app.voicefilter.SampleFilter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.pow

/**
 * The Phase 5j Private Call voice filter.
 *
 * v1 algorithm (locked in plan): pitch + formant shift by N semitones
 * via a tape-head granular shifter ([GranularPitchShifter]). Both
 * pitch and formants move together — that's enough for a recognizable
 * mask. Independent pitch / formant shifting is a v2 problem and can
 * land behind this same interface without touching PR-B2's WebRTC
 * fork.
 *
 * Wired to PR-B2's forked `SpeakeasyAudioRecord` via [SampleFilter];
 * see [xyz.speakeasyapp.app.voicefilter.VoiceFilterModule] for the
 * call-time toggle.
 *
 * Allocation-free per-frame: the temp short[]s are sized for the
 * largest plausible frame ([MAX_FRAME_SAMPLES]) and reused.
 */
class VoiceFilterDsp(
    /**
     * Pitch shift in semitones. Negative = down (sounds "deeper",
     * more disguised); positive = up. Default −2 matches the
     * locked plan choice for back-compat with pre-rc.17 callers.
     */
    semitones: Float = -2f,
    /**
     * Phase 2b: formant shift in semitones, INDEPENDENT of pitch.
     * 0 = preserve original formants (the vocal tract sounds the
     * same size as the speaker's, just with shifted pitch — like
     * helium without the chipmunk effect). Negative = formants
     * down (larger-sounding vocal tract, deeper resonance).
     * Positive = formants up (smaller, brighter, more "bright").
     * Default 0 means "match pitch shift" if the caller doesn't
     * specify — preserves rc.18 character for back-compat.
     *
     * Only honored by the phase-vocoder backend; granular ignores
     * (it can't separate pitch from formants).
     */
    formantSemitones: Float = 0f,
    /**
     * Per-frame latency budget in microseconds. Matches the 80ms p50
     * plan ceiling; we set the trip at 120ms (p95) so a noisy single
     * frame doesn't kill the call.
     */
    budgetMicros: Long = 120_000L,
    /** Injected for tests; production uses [System.nanoTime]. */
    private val nowNanos: () -> Long = { System.nanoTime() },
) : SampleFilter {

  private val factor: Float = 2.0.pow((semitones / 12.0)).toFloat()
  private val formantFactor: Float =
      2.0.pow((formantSemitones / 12.0)).toFloat()
  // Phase 2a: phase vocoder replaces the granular shifter as the
  // default. Lower latency (~10ms vs ~21ms) and no crackle, at the
  // cost of some pitch-shift artifacts on transients (plosives) and
  // sustained vowels (faint metallic edge). The boolean below lets
  // us flip back to granular fast if field testing finds the new
  // path worse on real hardware.
  // Phase 2b: vocoder takes formantFactor at init for independent
  // pitch/formant control. Granular ignores formant (can't do it).
  private val shifter: PitchShifter =
    if (USE_PHASE_VOCODER) PhaseVocoderShifterAdapter(formantFactor)
    else GranularShifterAdapter()
  private val guard = LatencyGuard(budgetMicros)

  /**
   * Scratch buffer for stereo→mono collapse and back-write. PCM16
   * samples (not bytes). Re-used across calls.
   */
  private val scratch = ShortArray(MAX_FRAME_SAMPLES)

  /** Most recently observed channel count; informational. */
  @Volatile var lastChannelCount: Int = 0
    private set

  override fun process(
      samples: ByteBuffer,
      sampleRateHz: Int,
      channelCount: Int,
  ): Boolean {
    if (guard.isTripped()) {
      // Failure-closed: once tripped, stay tripped. Caller (PR-B2's
      // fork) is expected to abort the active filter session by
      // checking `guard.isTripped()` and forwarding `latency_exceeded`
      // to the JS shim's `wrapTrack` rejection path.
      return false
    }
    if (channelCount !in 1..2) {
      // PR-B2's fork only configures mono or stereo capture; anything
      // else is a programming error worth a fast-fail.
      return false
    }
    lastChannelCount = channelCount

    val startNanos = nowNanos()
    val bytesPerSample = 2 * channelCount
    val frameSamples = samples.remaining() / bytesPerSample
    if (frameSamples == 0) return false
    if (frameSamples > MAX_FRAME_SAMPLES) {
      // Skip rather than reallocate; WebRTC always uses 10ms frames
      // which fit comfortably under MAX_FRAME_SAMPLES.
      return false
    }

    val originalOrder = samples.order()
    samples.order(ByteOrder.LITTLE_ENDIAN)
    val startPos = samples.position()

    // Decode → mono PCM16 in `scratch`.
    if (channelCount == 1) {
      for (i in 0 until frameSamples) {
        scratch[i] = samples.short
      }
    } else {
      for (i in 0 until frameSamples) {
        val l = samples.short.toInt()
        val r = samples.short.toInt()
        scratch[i] = ((l + r) shr 1).toShort()
      }
    }

    // In-place pitch+formant shift via the active shifter
    // (phase vocoder or granular — see USE_PHASE_VOCODER above).
    shifter.process(scratch, 0, scratch, 0, frameSamples, factor)

    // Encode → PCM16 back into the original byte buffer at the
    // original position. Stereo writes the same mono sample to both
    // channels.
    samples.position(startPos)
    if (channelCount == 1) {
      for (i in 0 until frameSamples) {
        samples.putShort(scratch[i])
      }
    } else {
      for (i in 0 until frameSamples) {
        samples.putShort(scratch[i])
        samples.putShort(scratch[i])
      }
    }
    samples.position(startPos)
    samples.order(originalOrder)

    val elapsed = (nowNanos() - startNanos) / 1_000L
    guard.recordFrame(elapsed)
    return true
  }

  /** Reset all DSP state; safe between calls. */
  fun reset() {
    shifter.reset()
    guard.reset()
  }

  /** Diagnostics; do not gate behavior. */
  fun isLatencyTripped(): Boolean = guard.isTripped()

  /** Shift factor (e.g. 0.89 for −2 semitones); diagnostics only. */
  fun shiftFactor(): Float = factor

  companion object {
    /**
     * 60ms at 48kHz mono. WebRTC standard frame is 10ms / 480
     * samples; this gives 6× headroom in case a future ADM bumps to
     * a longer accumulator.
     */
    const val MAX_FRAME_SAMPLES = 2880

    /** Pitch-shifter selection. `true` = phase vocoder (now at a 512
     *  window — see PhaseVocoderPitchShifter), `false` = granular.
     *
     *  1.0.x latency fix. An offline bench of the ACTUAL shifter code
     *  (amplitude-step group-delay + 30s RTF on the JVM, no device)
     *  measured the added call delay + per-frame CPU:
     *    vocoder @1024 (old): 30.3 ms, 253 µs/frame   ← the delay reported
     *    vocoder @512  (now): 16.6 ms, 364 µs/frame   ← shipped
     *    granular:            19.9 ms,   3.6 µs/frame
     *  The vocoder's delay is ~one analysis window, so halving the window
     *  (1024→512) nearly halves the delay — to BELOW granular — while
     *  KEEPING the vocoder's formant control (distinct Smoke/Velvet/Glass,
     *  no granular crackle). CPU is only ~44% over the already-shipped
     *  @1024 vocoder and well under the 10 ms/frame budget even at 15×
     *  mobile slowdown. Granular stays as the `false` fallback (trivial
     *  CPU) if the @512 voice character isn't acceptable on device. */
    private const val USE_PHASE_VOCODER = true
  }
}

/** Common shape so [VoiceFilterDsp] can hold either shifter. */
private interface PitchShifter {
  fun process(
      input: ShortArray,
      inOffset: Int,
      output: ShortArray,
      outOffset: Int,
      n: Int,
      factor: Float,
  )
  fun reset()
}

private class GranularShifterAdapter : PitchShifter {
  private val inner = GranularPitchShifter()
  override fun process(
      input: ShortArray,
      inOffset: Int,
      output: ShortArray,
      outOffset: Int,
      n: Int,
      factor: Float,
  ) = inner.process(input, inOffset, output, outOffset, n, factor)
  override fun reset() = inner.reset()
}

private class PhaseVocoderShifterAdapter(formantFactor: Float = 1f) : PitchShifter {
  private val inner = PhaseVocoderPitchShifter(formantFactor = formantFactor)
  override fun process(
      input: ShortArray,
      inOffset: Int,
      output: ShortArray,
      outOffset: Int,
      n: Int,
      factor: Float,
  ) = inner.process(input, inOffset, output, outOffset, n, factor)
  override fun reset() = inner.reset()
}
