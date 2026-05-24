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
     * Pitch+formant shift in semitones. Negative = down (sounds
     * "deeper", more disguised); positive = up. Default −2 matches
     * the locked plan choice; the orchestrator can pick a value per
     * peer or per call later if needed.
     */
    semitones: Float = -2f,
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
  private val shifter = GranularPitchShifter()
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

    // In-place pitch+formant shift.
    shifter.process(
        input = scratch,
        inOffset = 0,
        output = scratch,
        outOffset = 0,
        n = frameSamples,
        factor = factor,
    )

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
  }
}
