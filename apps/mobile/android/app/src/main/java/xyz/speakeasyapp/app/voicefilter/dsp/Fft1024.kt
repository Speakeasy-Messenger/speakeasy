package xyz.speakeasyapp.app.voicefilter.dsp

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * In-place radix-2 Cooley-Tukey FFT for the phase vocoder pitch
 * shifter (Phase 5j Private Call, Phase 2 voice filter).
 *
 * Size is fixed at 1024 — matches the vocoder analysis window and
 * lets the twiddle factors live in a single cache-friendly table.
 * Allocation-free per-call after init().
 *
 * # Math
 *
 * Computes `bin[k] = sum_{n=0..N-1} x[n] * exp(-2πikn/N)` in-place
 * on `(re, im)`. Bit reversal then `log2(N)` stages of butterflies.
 * Twiddle factors `cos(-2πi/N)`, `sin(-2πi/N)` are precomputed and
 * accessed by stride per stage.
 *
 * # Performance
 *
 * 1024-point at 30 Hz call rate ≈ sub-millisecond per FFT on a
 * mid-range Android phone (Snapdragon 6-series and up). The audio
 * thread runs the vocoder at 480 samples (10ms) cadence; one
 * analysis FFT every ~256 samples = ~187 FFTs/sec, well under the
 * realtime budget.
 *
 * # Why not Accelerate / JTransforms
 *
 * Avoiding a native dep keeps the Android build pipeline simple
 * (no CMake / JNI). Apple's Accelerate.framework is faster and
 * would be the right swap on iOS — see the Swift mirror in
 * `Fft1024.swift` for a note on that path.
 */
internal class Fft1024 {
  companion object {
    const val SIZE = 1024
    private const val SIZE_LOG2 = 10
  }

  private val cosTable = FloatArray(SIZE / 2)
  private val sinTable = FloatArray(SIZE / 2)

  init {
    for (i in 0 until SIZE / 2) {
      val theta = -2.0 * PI * i / SIZE
      cosTable[i] = cos(theta).toFloat()
      sinTable[i] = sin(theta).toFloat()
    }
  }

  /**
   * Forward FFT in-place. [re] and [im] must each be length SIZE.
   * On return they hold the complex spectrum bin-by-bin.
   */
  fun forward(re: FloatArray, im: FloatArray) {
    require(re.size == SIZE && im.size == SIZE) { "buffers must be SIZE=$SIZE" }
    bitReverse(re, im)
    butterflies(re, im)
  }

  /**
   * Inverse FFT in-place. Implemented as conjugate → forward FFT →
   * conjugate + scale 1/N. Same shape arrays as [forward].
   */
  fun inverse(re: FloatArray, im: FloatArray) {
    require(re.size == SIZE && im.size == SIZE) { "buffers must be SIZE=$SIZE" }
    for (i in 0 until SIZE) im[i] = -im[i]
    bitReverse(re, im)
    butterflies(re, im)
    val s = 1f / SIZE
    for (i in 0 until SIZE) {
      re[i] *= s
      im[i] = -im[i] * s
    }
  }

  private fun bitReverse(re: FloatArray, im: FloatArray) {
    var j = 0
    for (i in 1 until SIZE) {
      var bit = SIZE ushr 1
      while (j and bit != 0) {
        j = j xor bit
        bit = bit ushr 1
      }
      j = j xor bit
      if (i < j) {
        val tr = re[i]; re[i] = re[j]; re[j] = tr
        val ti = im[i]; im[i] = im[j]; im[j] = ti
      }
    }
  }

  private fun butterflies(re: FloatArray, im: FloatArray) {
    var len = 2
    var stage = 0
    while (stage < SIZE_LOG2) {
      val halfLen = len / 2
      val tableStep = SIZE / len
      var i = 0
      while (i < SIZE) {
        var k = 0
        for (jj in 0 until halfLen) {
          val l = i + jj
          val u = l + halfLen
          val cosK = cosTable[k]
          val sinK = sinTable[k]
          val tr = re[u] * cosK - im[u] * sinK
          val ti = re[u] * sinK + im[u] * cosK
          re[u] = re[l] - tr
          im[u] = im[l] - ti
          re[l] = re[l] + tr
          im[l] = im[l] + ti
          k += tableStep
        }
        i += len
      }
      len = len shl 1
      stage++
    }
  }
}
