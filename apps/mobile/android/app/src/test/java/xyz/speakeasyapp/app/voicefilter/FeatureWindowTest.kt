package xyz.speakeasyapp.app.voicefilter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class FeatureWindowTest {

  /** Push N samples into the window and capture the FIRST emitted raw triple. */
  private fun pushAndCapture(
    samples: FloatArray,
    sampleRate: Double = 48_000.0,
    windowSamples: Int = 1600,
  ): Triple<Double, Double, Double>? {
    val w = FeatureWindow(windowSamples = windowSamples)
    var result: Triple<Double, Double, Double>? = null
    for (s in samples) {
      if (result != null) break
      w.push(s, sampleRate) { l, p, z ->
        if (result == null) result = Triple(l, p, z)
      }
    }
    return result
  }

  @Test
  fun `silent window emits zero loudness zero pitch zero zcr`() {
    val n = 1600
    val samples = FloatArray(n) // all zeros
    val r = pushAndCapture(samples)!!
    assertEquals(0.0, r.first, 1e-6) // loudness
    assertEquals(0.0, r.second, 1e-6) // pitch
    assertEquals(0.0, r.third, 1e-6) // zcr
  }

  @Test
  fun `a 200Hz sine wave at 48kHz produces a detected pitch near 200Hz`() {
    // 200Hz is squarely inside the 80-400Hz speech pitch range the
    // detector is tuned for (a typical female fundamental sits at
    // 200-250Hz; male around 100-130Hz). 440Hz would be OUTSIDE the
    // search range — the detector would lock on the lag-218 octave
    // (220Hz) instead, which is the speech-range fundamental for
    // the second harmonic of a 440Hz tone.
    val n = 1600
    val sampleRate = 48_000.0
    val freq = 200.0
    val samples = FloatArray(n) { i ->
      (sin(2.0 * PI * freq * i / sampleRate) * 0.5).toFloat()
    }
    val r = pushAndCapture(samples, sampleRate)!!
    // Loudness ≈ RMS of a 0.5-amp sine = 0.5 / sqrt(2) ≈ 0.354.
    assertTrue("loudness ${r.first} should be ~0.354", r.first in 0.30..0.42)
    // Pitch detector should lock on the fundamental at ~200Hz.
    // Allow ±5Hz for integer-lag quantization (48000/200 = 240 exact;
    // 48000/239 ≈ 200.8, 48000/241 ≈ 199.2).
    assertTrue("pitch ${r.second} should be ~200Hz", r.second in 195.0..205.0)
    // ZCR for a sine = 2f / sampleRate. 2*200/48000 ≈ 0.0083.
    assertTrue("zcr ${r.third} should be ~0.0083", r.third in 0.006..0.011)
  }

  @Test
  fun `unvoiced noise produces zero pitch but nonzero loudness`() {
    val n = 1600
    val rng = java.util.Random(42)
    // Gaussian-ish noise via two-sample sum (Irwin–Hall n=2). Loudness > 0,
    // but autocorrelation has no clear peak above the voiced threshold.
    val samples = FloatArray(n) {
      ((rng.nextFloat() - rng.nextFloat()) * 0.3f)
    }
    val r = pushAndCapture(samples)!!
    assertTrue("loudness ${r.first} should be > 0", r.first > 0.05)
    assertEquals("pitchHz on noise must be 0", 0.0, r.second, 1e-9)
  }

  @Test
  fun `window emits on every Nth sample, not in between`() {
    val n = 1600
    val w = FeatureWindow(windowSamples = n)
    var count = 0
    for (i in 0 until (n * 3 - 1)) {
      w.push(0f, 48_000.0) { _, _, _ -> count += 1 }
    }
    // 2 full windows in 3*n - 1 samples.
    assertEquals(2, count)
  }

  @Test
  fun `reset clears the accumulator and resets the write index`() {
    val n = 1600
    val w = FeatureWindow(windowSamples = n)
    // Partial fill, then reset.
    for (i in 0 until 100) {
      w.push(0.5f, 48_000.0) { _, _, _ -> }
    }
    w.reset()
    // After reset, the next n samples should emit exactly once.
    var emitted = 0
    for (i in 0 until n) {
      w.push(0f, 48_000.0) { _, _, _ -> emitted += 1 }
    }
    assertEquals(1, emitted)
  }
}
