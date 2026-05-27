package xyz.speakeasyapp.app.voicefilter.dsp

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Phase vocoder pitch shifter for Speakeasy Private Call (Phase 5j,
 * Phase 2 voice filter rewrite). Drop-in replacement for
 * [GranularPitchShifter] — same `process(input, output, n, factor)`
 * signature so [VoiceFilterDsp] can swap behind one constant.
 *
 * # Algorithm
 *
 * Classical streaming SOLA-style phase vocoder:
 *
 *  1. Analysis: every [HOP_SIZE] input samples, window the most
 *     recent [FFT_SIZE] samples with a Hann window and FFT.
 *  2. Phase tracking: for each bin k, compute the true instantaneous
 *     frequency from the inter-frame phase deviation. This is the
 *     "phase advance" trick that distinguishes a real phase vocoder
 *     from a naive frequency-domain interpolator.
 *  3. Pitch shift: reassign bin k to bin `round(k * factor)`,
 *     accumulating magnitudes when multiple input bins map to one
 *     output bin (which is what gives the chord-like artifact that
 *     reads as "shifted voice").
 *  4. Synthesis: reconstruct output phases from the shifted true
 *     frequencies; inverse FFT; Hann-window again; overlap-add
 *     into the output ring.
 *
 * No formant preservation in this v1 — shift moves pitch AND
 * formants together (the "chipmunk" effect on shift-up, "Darth"
 * effect on shift-down). That's the same character as the granular
 * predecessor; the win here is **no crackle** and **lower
 * algorithmic delay** (~10ms instead of ~21ms). Independent formant
 * control lands in Phase 2b via LPC envelope manipulation.
 *
 * # Latency
 *
 * Algorithmic delay is `FFT_SIZE / 2 = 512` samples ≈ 10.6ms at
 * 48kHz — half of the rc.17 halved-granular delay. End-to-end
 * Private Call latency drops by another ~10ms.
 *
 * # Allocation
 *
 * Allocation-free per-frame. All scratch buffers are sized in
 * init() and reused.
 *
 * # Thread safety
 *
 * Not thread-safe. The single WebRTC audio-record thread is the
 * only intended caller.
 */
internal class PhaseVocoderPitchShifter(
    /** Formant scale factor in cycles-per-spectrum-bin units.
     *  1.0 = no formant shift (pitch and formant shift together,
     *  legacy Phase 2a behavior). >1.0 = formants shifted up
     *  (smaller-sounding vocal tract). <1.0 = formants shifted down
     *  (larger-sounding vocal tract). Independent of the pitch
     *  factor passed to [process], so pitchFactor=2,
     *  formantFactor=1 gives "same person speaking on helium" while
     *  pitchFactor=2, formantFactor=2 reverts to the chipmunk
     *  effect. Constructor-time because the formant shift is
     *  per-call configuration set at wrapTrack(), not per-process()
     *  variable. */
    private val formantFactor: Float = 1f,
) {
  companion object {
    /** Analysis + synthesis FFT length. Power of two for FFT, large
     *  enough that 80Hz speech fundamentals get adequate bin
     *  resolution (48000/1024 ≈ 47 Hz/bin). */
    private const val FFT_SIZE = Fft1024.SIZE
    /** Frame advance. 75% overlap (256 of 1024) is the canonical
     *  choice for voice — high enough that the synthesis Hann
     *  reconstructs flat (after squared-window overlap sum = const),
     *  low enough that CPU stays cheap. */
    private const val HOP_SIZE = 256
    private const val HALF_FFT = FFT_SIZE / 2
    /** Output gain compensates for the overlap-add of the squared
     *  Hann window. At 75% overlap with Hann analysis + synthesis,
     *  the sum-of-squares window OLA constant is 1.5; we divide. */
    private const val OLA_GAIN = 1f / 1.5f
    /** Cepstral envelope cutoff (quefrency bins). Bins 0..CEP_CUTOFF
     *  are kept; the rest are zeroed. Determines how "smooth" the
     *  extracted spectral envelope is. 32 bins ≈ formant detail
     *  (formant bandwidths of 50-200 Hz), far smaller than the
     *  pitch-period component which sits at hundreds of samples
     *  for adult voice (80-400 Hz fundamentals at 48 kHz). Keep
     *  too few → over-smoothed envelope, formants get smeared.
     *  Keep too many → pitch leaks into the envelope, breaks
     *  source/envelope separation. 32 is the standard pick for
     *  speech vocoders. */
    private const val CEP_CUTOFF = 32
    /** Floor on the spectral envelope before we divide by it.
     *  Prevents source-spectrum blowup in near-silent bins. */
    private const val ENV_FLOOR = 1e-6f
  }

  private val fft = Fft1024()
  private val hann = FloatArray(FFT_SIZE).also { w ->
    // Periodic Hann (N samples spanning [0, 2π)).
    for (i in 0 until FFT_SIZE) {
      w[i] = (0.5 - 0.5 * cos(2.0 * PI * i / FFT_SIZE)).toFloat()
    }
  }

  /** Input ring: the most recent FFT_SIZE samples, wrapped. */
  private val inputRing = FloatArray(FFT_SIZE)
  private var inputWritePos = 0
  /** Samples-since-last-analysis counter; triggers FFT every HOP. */
  private var hopCounter = 0

  /** Output ring: synthesized + overlap-added output not yet
   *  consumed by `process()`. Size > FFT_SIZE so one analysis
   *  frame's contribution can sit there while a few more hops
   *  worth of output stream out. */
  private val outputRing = FloatArray(FFT_SIZE + HOP_SIZE)
  /** Read position — where the NEXT output sample comes from. */
  private var outputReadPos = 0
  /** Write position — where the NEXT analysis frame's contribution
   *  begins overlap-adding. Always exactly `FFT_SIZE - HOP_SIZE`
   *  ahead of outputReadPos in steady state. */
  private var outputWritePos = FFT_SIZE - HOP_SIZE

  /** Per-bin previous-frame input phase, for instantaneous-frequency
   *  derivation. */
  private val lastInputPhase = FloatArray(HALF_FFT + 1)
  /** Per-bin accumulated output phase. */
  private val sumOutputPhase = FloatArray(HALF_FFT + 1)

  // Scratch (init'd once, reused per analysis).
  private val re = FloatArray(FFT_SIZE)
  private val im = FloatArray(FFT_SIZE)
  private val magnitude = FloatArray(HALF_FFT + 1)
  private val trueFreq = FloatArray(HALF_FFT + 1)
  private val newMagnitude = FloatArray(HALF_FFT + 1)
  private val newTrueFreq = FloatArray(HALF_FFT + 1)
  // Phase 2b: source-filter separation. The cepstrum needs its own
  // FFT scratch (we can't reuse `re`/`im` because they hold the
  // post-analysis spectrum while envelope extraction runs).
  private val cepRe = FloatArray(FFT_SIZE)
  private val cepIm = FloatArray(FFT_SIZE)
  /** Smooth spectral envelope (linear scale, one-sided). */
  private val envelope = FloatArray(HALF_FFT + 1)
  /** Formant-shifted target envelope reapplied to the source. */
  private val targetEnvelope = FloatArray(HALF_FFT + 1)
  /** Source-only magnitude (signal with envelope divided out). */
  private val sourceMagnitude = FloatArray(HALF_FFT + 1)
  /** Pitch-shifted source magnitude before envelope reapplication. */
  private val newSourceMagnitude = FloatArray(HALF_FFT + 1)

  /**
   * Process [n] mono PCM16 samples. Same contract as
   * [GranularPitchShifter.process]: input and output MAY alias.
   * `factor` > 1 shifts pitch up; < 1 shifts down.
   *
   * Output during the first ~FFT_SIZE samples is zero (warmup) —
   * the audio device's first ~21ms of a call always rides a silent
   * tail anyway (codec ramp-up), so users don't perceive this.
   */
  /**
   * Filter [n] PCM16 samples — reads from [input] starting at
   * [inOffset], writes to [output] starting at [outOffset]. Both
   * buffers MAY be the same array; the ring keeps its own copy.
   *
   * Same signature as [GranularPitchShifter.process] so
   * [VoiceFilterDsp] can swap between implementations behind one
   * constant.
   */
  fun process(
      input: ShortArray,
      inOffset: Int,
      output: ShortArray,
      outOffset: Int,
      n: Int,
      factor: Float,
  ) {
    val expectedPhasePerHop = 2.0 * PI * HOP_SIZE / FFT_SIZE
    for (i in 0 until n) {
      // 1) Push input into the ring.
      inputRing[inputWritePos] = input[inOffset + i].toFloat() / 32768f
      inputWritePos = (inputWritePos + 1) % FFT_SIZE

      // 2) Pull output from the ring; clear the read slot for the
      //    NEXT lap of the OLA accumulator.
      val outSample = outputRing[outputReadPos] * OLA_GAIN
      outputRing[outputReadPos] = 0f
      outputReadPos = (outputReadPos + 1) % outputRing.size
      val clamped = if (outSample > 1f) 1f else if (outSample < -1f) -1f else outSample
      output[outOffset + i] = (clamped * 32767f).toInt().toShort()

      // 3) Every HOP input samples, run an analysis FFT.
      hopCounter++
      if (hopCounter == HOP_SIZE) {
        hopCounter = 0
        analysisAndSynthesis(factor, expectedPhasePerHop)
      }
    }
  }

  fun reset() {
    for (i in 0 until FFT_SIZE) inputRing[i] = 0f
    for (i in 0 until outputRing.size) outputRing[i] = 0f
    for (i in 0 until lastInputPhase.size) {
      lastInputPhase[i] = 0f
      sumOutputPhase[i] = 0f
    }
    inputWritePos = 0
    outputReadPos = 0
    outputWritePos = FFT_SIZE - HOP_SIZE
    hopCounter = 0
  }

  private fun analysisAndSynthesis(factor: Float, expectedPhasePerHop: Double) {
    // Copy the latest FFT_SIZE samples from the ring into re[],
    // applying the Hann window. The ring's "oldest" sample is at
    // inputWritePos (which is also where we just wrapped past).
    val start = inputWritePos
    for (i in 0 until FFT_SIZE) {
      val ringIdx = (start + i) % FFT_SIZE
      re[i] = inputRing[ringIdx] * hann[i]
      im[i] = 0f
    }

    fft.forward(re, im)

    // Phase tracking + true-frequency derivation. Only the lower
    // half is meaningful for real input (Hermitian symmetry).
    for (k in 0..HALF_FFT) {
      val r = re[k]
      val ix = im[k]
      val mag = sqrt(r * r + ix * ix)
      val phase = atan2(ix, r)
      // Deviation from expected phase advance for this bin.
      val expected = k * expectedPhasePerHop
      var dev = (phase - lastInputPhase[k]).toDouble() - expected
      // Wrap to [-π, π].
      dev = dev - 2.0 * PI * Math.floor((dev + PI) / (2.0 * PI))
      // True instantaneous frequency in cycles per sample.
      // bin_center = k / FFT_SIZE; deviation correction is
      // dev / (2π * HOP_SIZE) cycles per sample.
      val trueFreqCyclesPerSample =
        k.toDouble() / FFT_SIZE + dev / (2.0 * PI * HOP_SIZE)
      magnitude[k] = mag
      trueFreq[k] = trueFreqCyclesPerSample.toFloat()
      lastInputPhase[k] = phase
    }

    // Phase 2b: extract the spectral envelope via cepstral
    // smoothing. The cepstrum is the IFFT of the log-magnitude
    // spectrum; low-pass-filtering it (zeroing high quefrencies)
    // and going back to log-magnitude leaves us with the smooth
    // formant envelope, separated from the pitch-period harmonic
    // structure. This is the "source-filter" decomposition that
    // lets us pitch-shift the source independently of the
    // formant envelope.
    extractEnvelope()

    // Build the formant-shifted target envelope. If formantFactor
    // == 1.0 this is identity (envelope[k] copied as-is). Otherwise
    // we resample env[k / formantFactor] so the formants land at
    // factor × their original frequencies. >1 = formants up
    // (smaller-sounding vocal tract); <1 = formants down (larger).
    buildTargetEnvelope()

    // Source = original magnitude / envelope. Floor at ENV_FLOOR
    // to avoid blowup in near-silent bins.
    for (k in 0..HALF_FFT) {
      sourceMagnitude[k] = magnitude[k] / max(envelope[k], ENV_FLOOR)
    }

    // Pitch shift the SOURCE: reassign source bin k to bin
    // round(k * factor). Adopt the true-freq of the loudest
    // contributor when multiple input bins map to one output.
    for (k in 0..HALF_FFT) {
      newSourceMagnitude[k] = 0f
      newTrueFreq[k] = 0f
    }
    for (k in 0..HALF_FFT) {
      val target = (k * factor).roundToInt()
      if (target in 0..HALF_FFT) {
        if (sourceMagnitude[k] > newSourceMagnitude[target]) {
          newTrueFreq[target] = trueFreq[k] * factor
        }
        newSourceMagnitude[target] += sourceMagnitude[k]
      }
    }

    // Reapply the target envelope to the shifted source to get
    // the final output magnitudes. Reconstruct phases from the
    // new true frequencies.
    for (k in 0..HALF_FFT) {
      newMagnitude[k] = newSourceMagnitude[k] * targetEnvelope[k]
      val advance = 2.0 * PI * newTrueFreq[k] * HOP_SIZE
      sumOutputPhase[k] = ((sumOutputPhase[k] + advance) % (2.0 * PI)).toFloat()
      val mag = newMagnitude[k]
      re[k] = mag * cos(sumOutputPhase[k])
      im[k] = mag * sin(sumOutputPhase[k])
    }
    // Hermitian-mirror for the upper half so IFFT yields real output.
    for (k in 1 until HALF_FFT) {
      re[FFT_SIZE - k] = re[k]
      im[FFT_SIZE - k] = -im[k]
    }
    // Nyquist bin (k=HALF_FFT) and DC (k=0) stay as-is.

    fft.inverse(re, im)

    // Apply synthesis Hann and overlap-add into output ring.
    var w = outputWritePos
    for (i in 0 until FFT_SIZE) {
      outputRing[w] += re[i] * hann[i]
      w = (w + 1) % outputRing.size
    }
    outputWritePos = (outputWritePos + HOP_SIZE) % outputRing.size
  }

  /**
   * Cepstral envelope: log-magnitude → IFFT → keep low quefrencies
   * → FFT → exp. Result populates [envelope] in linear scale at
   * indices 0..HALF_FFT.
   *
   * Two extra FFTs per hop, ~sub-millisecond on a modern phone.
   * Reads from [magnitude]; clobbers [cepRe] and [cepIm] but
   * doesn't touch [re]/[im] (those still hold the post-analysis
   * spectrum we need for phase reconstruction).
   */
  private fun extractEnvelope() {
    // Build full-spectrum log-magnitude with Hermitian symmetry.
    for (k in 0..HALF_FFT) {
      cepRe[k] = ln(max(magnitude[k], ENV_FLOOR))
      cepIm[k] = 0f
    }
    for (k in 1 until HALF_FFT) {
      cepRe[FFT_SIZE - k] = cepRe[k]
      cepIm[FFT_SIZE - k] = 0f
    }

    // IFFT to the time-domain (real) cepstrum.
    fft.inverse(cepRe, cepIm)

    // Low-pass: zero quefrencies beyond CEP_CUTOFF, both ends of
    // the symmetric cepstrum.
    for (n in (CEP_CUTOFF + 1) until (FFT_SIZE - CEP_CUTOFF)) {
      cepRe[n] = 0f
      cepIm[n] = 0f
    }

    // Forward FFT back to smooth log-magnitude.
    fft.forward(cepRe, cepIm)

    // Exponentiate to linear envelope. Imaginary part should be
    // ~0 (real-even input cepstrum); we trust the real part.
    for (k in 0..HALF_FFT) {
      envelope[k] = exp(cepRe[k])
    }
  }

  /**
   * Target envelope = source envelope resampled by 1/formantFactor.
   * `targetEnv[k] = envelope[k / formantFactor]` with linear
   * interpolation. formantFactor > 1 stretches the envelope along
   * the frequency axis (formants move up); < 1 compresses (formants
   * move down). formantFactor == 1 is a memcpy.
   */
  private fun buildTargetEnvelope() {
    if (formantFactor == 1f) {
      for (k in 0..HALF_FFT) targetEnvelope[k] = envelope[k]
      return
    }
    for (k in 0..HALF_FFT) {
      val srcK = k / formantFactor
      val srcKFloor = floor(srcK).toInt()
      val srcKCeil = srcKFloor + 1
      if (srcKFloor < 0 || srcKCeil > HALF_FFT) {
        // Out of range: clamp to edge envelope value to avoid a
        // brick-wall cut that would sound artificial.
        targetEnvelope[k] =
          if (srcKFloor < 0) envelope[0]
          else envelope[HALF_FFT]
        continue
      }
      val frac = srcK - srcKFloor
      targetEnvelope[k] =
        envelope[srcKFloor] * (1f - frac) + envelope[srcKCeil] * frac
    }
  }
}
