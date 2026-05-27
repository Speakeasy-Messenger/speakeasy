package xyz.speakeasyapp.app.voicefilter.dsp

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Correctness checks for [PhaseVocoderPitchShifter]. We can't audio-
 * test from a JVM — instead, drive synthetic sine waves through the
 * shifter and verify the dominant output frequency lands where the
 * pitch factor predicts. That's the algorithm's defining property;
 * if it holds the rest of the math is sound.
 *
 * Sample-rate-independent: the shifter operates on cycles per sample,
 * so we can pick a convenient SR and a few test frequencies in the
 * speech range (80-400 Hz at SR=48k).
 *
 * Warm-up: the streaming vocoder needs ~FFT_SIZE samples of input
 * before steady-state output. We feed >2× that before measuring.
 */
class PhaseVocoderPitchShifterTest {
  companion object {
    private const val SR = 48_000
    private const val FFT = Fft1024.SIZE  // 1024
    private const val WARMUP_SAMPLES = FFT * 3  // ~64 ms
    private const val MEASURE_SAMPLES = FFT * 4
  }

  @Test
  fun `passthrough factor=1 preserves input frequency`() {
    val outFreq = measureDominantOutputFreq(inputFreqHz = 220.0, factor = 1f)
    // factor=1 should hold the frequency steady, within FFT bin
    // resolution (47 Hz/bin at SR=48k, FFT=1024).
    assertTrue(
        "factor=1 should preserve 220Hz, got ${outFreq}Hz",
        kotlin.math.abs(outFreq - 220.0) < 60.0,
    )
  }

  @Test
  fun `factor 1_5 shifts 220Hz up toward 330Hz`() {
    val outFreq = measureDominantOutputFreq(inputFreqHz = 220.0, factor = 1.5f)
    assertTrue(
        "factor=1.5 should shift 220Hz toward 330Hz, got ${outFreq}Hz",
        outFreq > 280.0 && outFreq < 380.0,
    )
  }

  @Test
  fun `factor 0_75 shifts 220Hz down toward 165Hz`() {
    val outFreq = measureDominantOutputFreq(inputFreqHz = 220.0, factor = 0.75f)
    assertTrue(
        "factor=0.75 should shift 220Hz toward 165Hz, got ${outFreq}Hz",
        outFreq > 130.0 && outFreq < 200.0,
    )
  }

  @Test
  fun `output is not silent`() {
    // Sanity: feed a loud sine, confirm we get non-trivial output
    // back (catches dead OLA / scale bugs that produce silence).
    val shifter = PhaseVocoderPitchShifter()
    val input = sineSamples(220.0, WARMUP_SAMPLES + MEASURE_SAMPLES, amplitude = 0.5f)
    val output = ShortArray(input.size)
    shifter.process(input, 0, output, 0, input.size, factor = 1f)
    val measured = output.sliceArray(WARMUP_SAMPLES until output.size)
    val rms = rms(measured)
    assertTrue("output should not be silent, rms=$rms", rms > 100.0)
  }

  /**
   * Run the shifter on a long pure sine and identify the loudest
   * output frequency via FFT. Returns Hz.
   */
  private fun measureDominantOutputFreq(inputFreqHz: Double, factor: Float): Double {
    val shifter = PhaseVocoderPitchShifter()
    val totalSamples = WARMUP_SAMPLES + MEASURE_SAMPLES
    val input = sineSamples(inputFreqHz, totalSamples, amplitude = 0.5f)
    val output = ShortArray(totalSamples)
    shifter.process(input, 0, output, 0, totalSamples, factor)
    val measured = output.sliceArray(WARMUP_SAMPLES until totalSamples)
    return dominantFreq(measured, SR)
  }

  private fun sineSamples(freqHz: Double, n: Int, amplitude: Float): ShortArray {
    return ShortArray(n) { i ->
      val v = amplitude * sin(2.0 * PI * freqHz * i / SR)
      (v * 32767f).toInt().coerceIn(-32768, 32767).toShort()
    }
  }

  /** FFT-based dominant frequency estimator. */
  private fun dominantFreq(samples: ShortArray, sr: Int): Double {
    // Pick the most recent FFT-aligned window.
    val fft = Fft1024()
    val n = FFT
    val start = samples.size - n
    val re = FloatArray(n)
    val im = FloatArray(n)
    for (i in 0 until n) {
      // Hann window to reduce spectral leakage.
      val w = 0.5 - 0.5 * cos(2.0 * PI * i / n)
      re[i] = (samples[start + i].toFloat() / 32768f * w).toFloat()
    }
    fft.forward(re, im)
    var bestK = 1
    var bestMag = 0.0
    for (k in 1 until n / 2) {
      val m = hypot(re[k].toDouble(), im[k].toDouble())
      if (m > bestMag) {
        bestMag = m
        bestK = k
      }
    }
    return bestK.toDouble() * sr / n
  }

  private fun rms(samples: ShortArray): Double {
    var sum = 0.0
    for (s in samples) {
      val f = s.toDouble()
      sum += f * f
    }
    return sqrt(sum / samples.size)
  }
}
