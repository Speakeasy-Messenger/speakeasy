package xyz.speakeasyapp.app.voicefilter.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/**
 * FFT correctness checks for the hand-rolled radix-2 [Fft1024].
 * Validates against synthetic signals where the spectrum is known
 * analytically — no audio file fixtures, no platform dependencies,
 * runs on the JVM.
 */
class Fft1024Test {
  @Test
  fun `single sine wave appears in the expected bin`() {
    val fft = Fft1024()
    val n = Fft1024.SIZE
    // A bin-aligned sine: k=10 (= 10/N cycles per sample). Pure tone
    // → all magnitude concentrated in bin 10 (and Hermitian mirror).
    val k = 10
    val re = FloatArray(n) { i -> cos(2.0 * PI * k * i / n).toFloat() }
    val im = FloatArray(n)
    fft.forward(re, im)
    val magK = hypot(re[k].toDouble(), im[k].toDouble())
    // Peak at bin k should dwarf any other bin.
    var maxOther = 0.0
    for (i in 0..n / 2) {
      if (i == k) continue
      val m = hypot(re[i].toDouble(), im[i].toDouble())
      if (m > maxOther) maxOther = m
    }
    assertTrue(
        "bin $k magnitude=$magK should dominate (other peaks ≤ $maxOther)",
        magK > 100 * maxOther,
    )
  }

  @Test
  fun `forward then inverse round-trips within 1e-4`() {
    val fft = Fft1024()
    val n = Fft1024.SIZE
    val re = FloatArray(n) { i ->
      // Arbitrary multi-tone signal.
      (sin(2.0 * PI * 3 * i / n) + 0.5 * cos(2.0 * PI * 17 * i / n)).toFloat()
    }
    val im = FloatArray(n)
    val original = re.copyOf()
    fft.forward(re, im)
    fft.inverse(re, im)
    var maxErr = 0f
    for (i in 0 until n) {
      val err = kotlin.math.abs(re[i] - original[i])
      if (err > maxErr) maxErr = err
    }
    assertTrue("round-trip max error $maxErr should be < 1e-4", maxErr < 1e-4f)
  }

  @Test
  fun `DC signal has all magnitude in bin 0`() {
    val fft = Fft1024()
    val n = Fft1024.SIZE
    val re = FloatArray(n) { 1f }
    val im = FloatArray(n)
    fft.forward(re, im)
    val dc = hypot(re[0].toDouble(), im[0].toDouble())
    var maxOther = 0.0
    for (i in 1 until n) {
      val m = hypot(re[i].toDouble(), im[i].toDouble())
      if (m > maxOther) maxOther = m
    }
    assertEquals(n.toDouble(), dc, 1e-3)
    assertTrue("non-DC max=$maxOther should be ~0", maxOther < 1e-3)
  }
}
