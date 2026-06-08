package xyz.speakeasyapp.app.voicefilter.dsp

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * 512-point radix-2 Cooley-Tukey FFT — the lower-latency sibling of
 * [Fft1024]. Identical math; SIZE=512 (SIZE_LOG2=9). Used by
 * [PhaseVocoderPitchShifter] to halve the analysis window (and thus the
 * ~30ms group delay measured at 1024) for the 1.0.x voice-filter latency
 * fix, at the cost of coarser bin resolution (48000/512 ≈ 94 Hz/bin vs
 * 47). Allocation-free per-call after init().
 */
internal class Fft512 {
  companion object {
    const val SIZE = 512
    private const val SIZE_LOG2 = 9
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

  fun forward(re: FloatArray, im: FloatArray) {
    require(re.size == SIZE && im.size == SIZE) { "buffers must be SIZE=$SIZE" }
    bitReverse(re, im)
    butterflies(re, im)
  }

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
