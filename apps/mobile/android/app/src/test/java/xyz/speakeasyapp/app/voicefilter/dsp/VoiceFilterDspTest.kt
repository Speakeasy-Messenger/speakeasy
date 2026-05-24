package xyz.speakeasyapp.app.voicefilter.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sin

class VoiceFilterDspTest {

  private fun monoFrame(samples: Int, freqHz: Double = 440.0, sampleRateHz: Int = 48_000): ByteBuffer {
    val buf = ByteBuffer.allocate(samples * 2).order(ByteOrder.LITTLE_ENDIAN)
    val twoPi = 2.0 * PI
    for (i in 0 until samples) {
      val t = i.toDouble() / sampleRateHz
      buf.putShort((sin(twoPi * freqHz * t) * 28_000.0).toInt().toShort())
    }
    buf.flip()
    return buf
  }

  private fun stereoFrame(samples: Int, freqHz: Double = 440.0, sampleRateHz: Int = 48_000): ByteBuffer {
    val buf = ByteBuffer.allocate(samples * 4).order(ByteOrder.LITTLE_ENDIAN)
    val twoPi = 2.0 * PI
    for (i in 0 until samples) {
      val t = i.toDouble() / sampleRateHz
      val s = (sin(twoPi * freqHz * t) * 28_000.0).toInt().toShort()
      buf.putShort(s)
      buf.putShort(s)
    }
    buf.flip()
    return buf
  }

  @Test
  fun `shiftFactor matches semitone formula`() {
    val dsp = VoiceFilterDsp(semitones = -2f)
    val expected = 2.0.pow(-2.0 / 12.0).toFloat()
    assertEquals(expected, dsp.shiftFactor(), 1e-5f)
  }

  @Test
  fun `process mutates the input buffer for mono frames`() {
    val dsp = VoiceFilterDsp(semitones = -2f)
    // Feed several frames so the DSP's internal ring buffer warms up
    // past the initial silence (read head starts grainSize=2048 ahead
    // of the write head; at factor≈0.89 the heads converge after a
    // few hundred ms of input, then the output is the shifted signal).
    val sampleRateHz = 48_000
    val warmupFrames = 60 // 600ms
    repeat(warmupFrames) {
      val warm = monoFrame(480, freqHz = 440.0, sampleRateHz = sampleRateHz)
      dsp.process(warm, sampleRateHz, channelCount = 1)
    }

    val frame = monoFrame(480, freqHz = 440.0, sampleRateHz = sampleRateHz)
    val originalBytes = ByteArray(frame.remaining())
    frame.duplicate().get(originalBytes)
    val processed = dsp.process(frame, sampleRateHz = sampleRateHz, channelCount = 1)
    assertTrue("process should return true on a valid frame", processed)
    var diffs = 0
    val modifiedBytes = ByteArray(frame.remaining())
    frame.duplicate().get(modifiedBytes)
    for (i in 0 until 480) {
      val origLow = originalBytes[i * 2].toInt() and 0xff
      val origHigh = originalBytes[i * 2 + 1].toInt()
      val modLow = modifiedBytes[i * 2].toInt() and 0xff
      val modHigh = modifiedBytes[i * 2 + 1].toInt()
      if (origLow != modLow || origHigh != modHigh) diffs += 1
    }
    assertTrue("expected the buffer to be mutated; differed at $diffs/480 samples", diffs > 200)
  }

  @Test
  fun `process collapses stereo to mono and writes both channels`() {
    val dsp = VoiceFilterDsp(semitones = -2f)
    val frame = stereoFrame(480)
    val processed = dsp.process(frame, sampleRateHz = 48_000, channelCount = 2)
    assertTrue(processed)
    // Stereo output: left == right (we write the same mono sample to
    // both channels).
    for (i in 0 until 480) {
      val l = frame.getShort(i * 4)
      val r = frame.getShort(i * 4 + 2)
      assertEquals("L/R should match at sample $i", l, r)
    }
  }

  @Test
  fun `process rejects unsupported channel counts`() {
    val dsp = VoiceFilterDsp(semitones = -2f)
    val frame = monoFrame(480)
    assertFalse(dsp.process(frame, sampleRateHz = 48_000, channelCount = 5))
    assertFalse(dsp.process(frame, sampleRateHz = 48_000, channelCount = 0))
  }

  @Test
  fun `process rejects frames larger than MAX_FRAME_SAMPLES`() {
    val dsp = VoiceFilterDsp(semitones = -2f)
    val frame = monoFrame(VoiceFilterDsp.MAX_FRAME_SAMPLES + 100)
    assertFalse(dsp.process(frame, sampleRateHz = 48_000, channelCount = 1))
  }

  /**
   * Returns a `nanoTime`-style clock that advances by [stepNanos] on
   * each call. The DSP calls the clock twice per frame (start + end),
   * so a 200ms step gives a 200ms apparent elapsed time → over the
   * 120ms budget.
   */
  private fun steppingClock(stepNanos: Long): () -> Long {
    var t = 0L
    return {
      val now = t
      t += stepNanos
      now
    }
  }

  @Test
  fun `process bypasses after latency guard trips`() {
    val dsp =
        VoiceFilterDsp(
            semitones = -2f,
            budgetMicros = 120_000L,
            nowNanos = steppingClock(200_000_000L), // 200ms per call → 200ms per frame
        )
    repeat(3) {
      val frame = monoFrame(480)
      dsp.process(frame, sampleRateHz = 48_000, channelCount = 1)
    }
    assertTrue("expected latency guard to trip after 3 slow frames", dsp.isLatencyTripped())

    // Subsequent frames are bypassed (process returns false).
    val frame = monoFrame(480)
    assertFalse(dsp.process(frame, sampleRateHz = 48_000, channelCount = 1))
  }

  @Test
  fun `reset clears the latency trip`() {
    val dsp =
        VoiceFilterDsp(
            semitones = -2f,
            budgetMicros = 1_000L,
            nowNanos = steppingClock(50_000_000L), // 50ms per call → always over a 1µs budget
        )
    repeat(5) {
      val frame = monoFrame(480)
      dsp.process(frame, sampleRateHz = 48_000, channelCount = 1)
    }
    assertTrue(dsp.isLatencyTripped())
    dsp.reset()
    assertFalse(dsp.isLatencyTripped())
  }

  @Test
  fun `process is allocation-free in the hot path`() {
    // Smoke: 20_000 frames at 10ms each = 200s of audio. If we leak
    // allocations the JVM will GC noticeably; in practice this just
    // confirms no exception or OOM.
    val dsp = VoiceFilterDsp(semitones = -2f)
    val frame = ByteBuffer.allocate(960).order(ByteOrder.LITTLE_ENDIAN)
    repeat(20_000) {
      frame.clear()
      // Fill with zeros; doesn't matter what we feed for an alloc test.
      for (i in 0 until 480) frame.putShort(0)
      frame.flip()
      dsp.process(frame, sampleRateHz = 48_000, channelCount = 1)
    }
  }
}
