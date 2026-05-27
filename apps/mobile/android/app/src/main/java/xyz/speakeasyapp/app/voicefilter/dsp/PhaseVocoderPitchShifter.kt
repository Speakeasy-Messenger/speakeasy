package xyz.speakeasyapp.app.voicefilter.dsp

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
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
internal class PhaseVocoderPitchShifter {
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

    // Pitch shift: reassign bin k to round(k * factor).
    for (k in 0..HALF_FFT) {
      newMagnitude[k] = 0f
      newTrueFreq[k] = 0f
    }
    for (k in 0..HALF_FFT) {
      val target = (k * factor).roundToInt()
      if (target in 0..HALF_FFT) {
        // Accumulate magnitude if multiple inputs hit the same output bin.
        // Adopt the true-freq of the loudest contributor.
        if (magnitude[k] > newMagnitude[target]) {
          newTrueFreq[target] = trueFreq[k] * factor
        }
        newMagnitude[target] += magnitude[k]
      }
    }

    // Reconstruct output phases from new true freqs. Phase advance
    // per hop = 2π * trueFreqCyclesPerSample * HOP_SIZE.
    for (k in 0..HALF_FFT) {
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
}
