package xyz.speakeasyapp.app.voicefilter.dsp

/**
 * Tape-head granular pitch shifter — the simplest "voice mask" DSP.
 *
 * Maintains a ring buffer of recent input samples; a read head advances
 * at `factor` samples per output sample (factor > 1 ⇒ pitch up,
 * factor < 1 ⇒ pitch down). When the read head approaches the write
 * head (from either side, since they share a ring), it cross-fades
 * with the sample read [grainSize] samples earlier — the classic
 * granular trick that keeps the "tape" scrubbing continuously even
 * though the rates differ.
 *
 * This shifts BOTH pitch and formants by the same factor; that's the
 * locked v1 behavior. A future PR can swap this for an independent
 * pitch+formant shifter (phase vocoder + cepstral whitening) behind
 * the same [SampleFilter][xyz.speakeasyapp.app.voicefilter.SampleFilter]
 * interface without touching the WebRTC ADM fork.
 *
 * Allocation-free per-frame: all buffers sized in the constructor.
 * Not thread-safe; the single WebRTC audio-record thread is the only
 * intended caller.
 */
internal class GranularPitchShifter(
    /**
     * Length of one grain in samples. ~42ms at 48kHz is a good
     * compromise between artifact frequency (smaller grain = louder
     * crackle) and pitch resolution (larger grain = audible delay).
     */
    private val grainSize: Int = 2048,
    /**
     * Cross-fade width in samples. Wider = smoother but more
     * "smear"; narrower = sharper but more crackle. 256 ≈ 5ms at
     * 48kHz, a small fraction of the grain.
     */
    private val crossFade: Int = 256,
) {
  init {
    require(grainSize > 0 && grainSize and (grainSize - 1) == 0) {
      "grainSize must be a positive power of two for the ring-wrap arithmetic"
    }
    require(crossFade in 1..(grainSize / 4)) {
      "crossFade must be in (0, grainSize/4]"
    }
  }

  /** Ring buffer holding the most recent inputs in float-normalized form. */
  private val ringSize = grainSize * 2
  private val ring = FloatArray(ringSize)
  private var writeIdx = 0

  /**
   * Tape read head as a `Double` so fractional rates accumulate without
   * drift. Wraps into `[0, ringSize)` each frame.
   *
   * Starts diametrically opposite the write head so the cross-fade
   * doesn't fire on frame 0: at factor=1.0 the heads keep their
   * `ringSize/2` separation and the output is a clean passthrough; at
   * shift factors close to 1, the first cross-fade lap is pushed to
   * the ~0.4–0.8s mark (well past the test/UX warmup).
   */
  private var readPos = (grainSize).toDouble()

  /**
   * Filter one frame of `n` PCM16 samples in-place — reads from
   * [input] starting at [inOffset], writes to [output] starting at
   * [outOffset]. Both buffers MAY be the same array; the ring keeps
   * its own copy.
   *
   * @param factor positive pitch-shift factor. `1.0` is a passthrough.
   */
  fun process(
      input: ShortArray,
      inOffset: Int,
      output: ShortArray,
      outOffset: Int,
      n: Int,
      factor: Float,
  ) {
    // 1) Snapshot input into the ring buffer first so the read head
    // never crosses fresh data this frame (avoids self-feedback when
    // input === output).
    var w = writeIdx
    for (i in 0 until n) {
      ring[w] = input[inOffset + i] / 32768f
      w = (w + 1) and (ringSize - 1)
    }
    writeIdx = w

    // 2) Render output via the tape head.
    val crossFadeF = crossFade.toFloat()
    val ringMask = ringSize - 1
    val grainSizeI = grainSize
    var pos = readPos
    val factorD = factor.toDouble()
    for (i in 0 until n) {
      val posI = pos.toInt()
      val posF = (pos - posI).toFloat()
      val a0 = posI and ringMask
      val a1 = (posI + 1) and ringMask
      val sa = ring[a0] + (ring[a1] - ring[a0]) * posF

      // The grain-back position lags by one grainSize, so wrapping
      // there gives us a sample whose cross-fade window doesn't
      // collide with the write head at the same instant.
      val bI = posI - grainSizeI
      val b0 = bI and ringMask
      val b1 = (bI + 1) and ringMask
      val sb = ring[b0] + (ring[b1] - ring[b0]) * posF

      // Forward distance to write head, normalized into [0, ringSize).
      val dist = (writeIdx - posI - 1 + ringSize) and ringMask

      val mix =
          when {
            dist < crossFade -> dist.toFloat() / crossFadeF
            dist >= ringSize - crossFade -> (ringSize - dist).toFloat() / crossFadeF
            else -> 1f
          }
      val mixed = sa * mix + sb * (1f - mix)

      // Clamp to PCM16 range.
      val clamped =
          if (mixed > 1f) 1f else if (mixed < -1f) -1f else mixed
      output[outOffset + i] = (clamped * 32767f).toInt().toShort()

      pos += factorD
      if (pos >= ringSize) pos -= ringSize
      if (pos < 0) pos += ringSize
    }
    readPos = pos
  }

  fun reset() {
    ring.fill(0f)
    writeIdx = 0
    readPos = grainSize.toDouble()
  }
}
