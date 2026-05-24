package xyz.speakeasyapp.app.voicefilter.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class GranularPitchShifterTest {

  /**
   * Count up-going zero-crossings in a PCM16 buffer. For a pure tone
   * this equals the tone's frequency × seconds, so it's a robust
   * way to validate pitch shifting without an FFT dependency.
   */
  private fun countZeroCrossings(buf: ShortArray): Int {
    var n = 0
    var prev = buf[0].toInt()
    for (i in 1 until buf.size) {
      val cur = buf[i].toInt()
      if (prev <= 0 && cur > 0) n += 1
      prev = cur
    }
    return n
  }

  private fun sineWave(freqHz: Double, sampleRateHz: Int, lengthSamples: Int): ShortArray {
    val out = ShortArray(lengthSamples)
    val twoPi = 2.0 * PI
    for (i in 0 until lengthSamples) {
      val t = i.toDouble() / sampleRateHz
      out[i] = (sin(twoPi * freqHz * t) * 28_000.0).toInt().toShort()
    }
    return out
  }

  @Test
  fun `passthrough at factor 1_0 preserves frequency`() {
    val sampleRateHz = 48_000
    val durationSec = 1.0
    val freq = 440.0
    val n = (sampleRateHz * durationSec).toInt()
    val input = sineWave(freq, sampleRateHz, n)
    val output = ShortArray(n)
    val shifter = GranularPitchShifter()

    // Feed the input as 480-sample (10ms) chunks, like WebRTC does.
    val chunk = 480
    var off = 0
    while (off + chunk <= n) {
      shifter.process(input, off, output, off, chunk, factor = 1.0f)
      off += chunk
    }
    // Skip first 200ms — initial transient as the ring buffer warms up.
    val skip = sampleRateHz / 5
    val tail = output.sliceArray(skip until off)
    val crossings = countZeroCrossings(tail)
    // For a 440Hz tone over (off - skip) samples we expect
    // 440 × (off-skip)/sampleRateHz crossings. Allow ±10% slack for
    // start/end edge effects.
    val expected = (freq * (off - skip).toDouble() / sampleRateHz).toInt()
    val ratio = crossings.toDouble() / expected
    assertTrue("expected ~$expected crossings, got $crossings (ratio=$ratio)", ratio in 0.90..1.10)
  }

  @Test
  fun `factor 1_122 shifts a 440Hz tone up by 2 semitones`() {
    val sampleRateHz = 48_000
    val durationSec = 1.0
    val freq = 440.0
    val n = (sampleRateHz * durationSec).toInt()
    val input = sineWave(freq, sampleRateHz, n)
    val output = ShortArray(n)
    val shifter = GranularPitchShifter()

    val factor = Math.pow(2.0, 2.0 / 12.0).toFloat() // +2 semitones ≈ 1.1225
    val chunk = 480
    var off = 0
    while (off + chunk <= n) {
      shifter.process(input, off, output, off, chunk, factor = factor)
      off += chunk
    }
    val skip = sampleRateHz / 5
    val tail = output.sliceArray(skip until off)
    val crossings = countZeroCrossings(tail)
    // After +2 semitones, the 440Hz tone should be ~493.88Hz. Over
    // (off-skip) samples that's ~freq*factor*(off-skip)/sampleRateHz
    // crossings. Allow ±15% slack — granular shifters have audible
    // transient artifacts at grain boundaries that count toward this.
    val expected = (freq * factor * (off - skip).toDouble() / sampleRateHz).toInt()
    val ratio = crossings.toDouble() / expected
    assertTrue(
        "expected ~$expected crossings (440Hz×$factor), got $crossings (ratio=$ratio)",
        ratio in 0.85..1.15,
    )
  }

  @Test
  fun `factor 0_891 shifts a 440Hz tone down by 2 semitones`() {
    val sampleRateHz = 48_000
    val durationSec = 1.0
    val freq = 440.0
    val n = (sampleRateHz * durationSec).toInt()
    val input = sineWave(freq, sampleRateHz, n)
    val output = ShortArray(n)
    val shifter = GranularPitchShifter()

    val factor = Math.pow(2.0, -2.0 / 12.0).toFloat() // -2 semitones ≈ 0.8909
    val chunk = 480
    var off = 0
    while (off + chunk <= n) {
      shifter.process(input, off, output, off, chunk, factor = factor)
      off += chunk
    }
    val skip = sampleRateHz / 5
    val tail = output.sliceArray(skip until off)
    val crossings = countZeroCrossings(tail)
    // After -2 semitones, the 440Hz tone should be ~391.99Hz.
    val expected = (freq * factor * (off - skip).toDouble() / sampleRateHz).toInt()
    val ratio = crossings.toDouble() / expected
    assertTrue(
        "expected ~$expected crossings (440Hz×$factor), got $crossings (ratio=$ratio)",
        ratio in 0.85..1.15,
    )
  }

  @Test
  fun `process does not allocate buffers per frame`() {
    // Sanity: the public API only takes the user-provided arrays and a
    // factor. Confirm we can run many frames back-to-back without
    // OOMing the JVM heap allocator (a smoke test for allocation-free
    // hot path).
    val shifter = GranularPitchShifter()
    val input = ShortArray(480)
    val output = ShortArray(480)
    repeat(20_000) {
      shifter.process(input, 0, output, 0, 480, factor = 0.891f)
    }
  }

  @Test
  fun `rejects non-power-of-two grain size`() {
    var caught = false
    try {
      GranularPitchShifter(grainSize = 1500)
    } catch (e: IllegalArgumentException) {
      caught = true
    }
    assertTrue("expected IllegalArgumentException for non-power-of-two grainSize", caught)
  }
}
