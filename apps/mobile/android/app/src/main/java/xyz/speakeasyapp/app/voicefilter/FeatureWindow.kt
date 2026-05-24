package xyz.speakeasyapp.app.voicefilter

import kotlin.math.sqrt

/**
 * Phase 5j PR-G — 33ms feature window accumulator + raw-feature
 * computation. Used by the forked [org.webrtc.audio.WebRtcAudioRecord]:
 * every captured frame post-SampleFilter, PCM16 samples accumulate
 * into a fixed-length Float window. When full, we compute loudness
 * (RMS), pitchHz (autocorrelation peak), and zcr (zero-crossing
 * rate), forward them to [VoiceFilterModule.emitFeatures] (which
 * sends an `SpeakeasyVoiceFilterFeatures` event to JS), and reset.
 *
 * Mirrors the JS-side `audio-feature-extractor.ts` algorithms so
 * the JS smoothing/calibration feeds genuinely comparable raw
 * features — same RMS, same autocorrelation pitch detector with
 * VOICED_THRESHOLD=0.85 + first-peak-above-threshold bias, same
 * strict-sign ZCR definition. Same code as iOS `FeatureWindow.swift`.
 *
 * Not thread-safe — the single AudioRecordThread is the only caller.
 */
class FeatureWindow(
    /** 33ms at 48kHz. */
    private val windowSamples: Int = 1600,
    /** Speech pitch range — autocorrelation lag bounds derive from these. */
    private val minPitchHz: Double = 80.0,
    private val maxPitchHz: Double = 400.0,
    /** Voiced threshold (autocorrelation peak height to call a real F0). */
    private val voicedThreshold: Float = 0.85f,
    /** RMS gate — below this, skip the pitch search outright. */
    private val rmsSilenceFloor: Float = 0.02f,
) {
  private val accum = FloatArray(windowSamples)
  private var writeIdx = 0

  /**
   * Append a single mono Float sample (normalized [-1, 1]). When
   * the window is full, invoke [onWindow] with the computed features
   * and reset.
   */
  fun push(s: Float, sampleRate: Double, onWindow: (loudness: Double, pitchHz: Double, zcr: Double) -> Unit) {
    accum[writeIdx] = s
    writeIdx += 1
    if (writeIdx >= windowSamples) {
      val r = compute(sampleRate)
      onWindow(r.loudness, r.pitchHz, r.zcr)
      writeIdx = 0
    }
  }

  private data class Raw(val loudness: Double, val pitchHz: Double, val zcr: Double)

  private fun compute(sampleRate: Double): Raw {
    if (windowSamples < 32) return Raw(0.0, 0.0, 0.0)

    // RMS.
    var sumSq = 0f
    for (i in 0 until windowSamples) {
      val v = accum[i]
      sumSq += v * v
    }
    val rms = sqrt(sumSq / windowSamples.toFloat())

    // ZCR — strict-sign crossings, ignore exact zeros.
    var crossings = 0
    var prev = accum[0]
    for (i in 1 until windowSamples) {
      val cur = accum[i]
      if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) {
        crossings += 1
      }
      prev = cur
    }
    val zcr = crossings.toDouble() / windowSamples.toDouble()

    // Pitch via autocorrelation. Skip on near-silence.
    var pitchHz = 0.0
    if (rms >= rmsSilenceFloor) {
      val minLag = (sampleRate / maxPitchHz).toInt()
      val maxLag = (sampleRate / minPitchHz).toInt()
      if (maxLag < windowSamples) {
        pitchHz = estimatePitchHz(minLag, maxLag, sampleRate)
      }
    }

    return Raw(rms.toDouble(), pitchHz, zcr)
  }

  /**
   * First-peak-above-threshold autocorrelation pitch detector. Walks
   * lag in increasing order (= decreasing frequency) and returns the
   * first local maximum whose normalized autocorrelation exceeds
   * [voicedThreshold]. Biases reliably toward the fundamental.
   */
  private fun estimatePitchHz(minLag: Int, maxLag: Int, sampleRate: Double): Double {
    val lagCount = maxLag - minLag + 1
    if (lagCount <= 0) return 0.0
    val norms = FloatArray(lagCount)
    for (lag in minLag..maxLag) {
      var corr = 0f
      var energyA = 0f
      var energyB = 0f
      val end = windowSamples - lag
      if (end <= 0) continue
      for (i in 0 until end) {
        val a = accum[i]
        val b = accum[i + lag]
        corr += a * b
        energyA += a * a
        energyB += b * b
      }
      val denom = sqrt(energyA * energyB)
      norms[lag - minLag] = if (denom == 0f) 0f else corr / denom
    }
    var bestLag = -1
    for (k in 1 until (lagCount - 1)) {
      if (norms[k] >= voicedThreshold
          && norms[k] > norms[k - 1]
          && norms[k] > norms[k + 1]) {
        bestLag = k + minLag
        break
      }
    }
    return if (bestLag <= 0) 0.0 else sampleRate / bestLag.toDouble()
  }

  fun reset() {
    for (i in 0 until windowSamples) accum[i] = 0f
    writeIdx = 0
  }
}
