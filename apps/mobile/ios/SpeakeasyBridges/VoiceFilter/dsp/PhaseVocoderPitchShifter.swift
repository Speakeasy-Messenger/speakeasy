//
//  PhaseVocoderPitchShifter.swift
//  Speakeasy — Phase 5j Private Call voice filter, Phase 2
//
//  Swift port of
//  apps/mobile/android/.../voicefilter/dsp/PhaseVocoderPitchShifter.kt
//
//  Streaming SOLA-style phase vocoder pitch shifter. Drop-in
//  replacement for [GranularPitchShifter] — same
//  `process(input, output, count, factor)` signature so
//  [VoiceFilterDsp] can swap between them behind one constant.
//
//  Same algorithm, latency, and limitations as the Kotlin
//  version — see that file's docstring for the math + tradeoffs.
//
//  Allocation-free per-frame: all scratch buffers sized in init().
//  Not thread-safe; the single AVAudioEngine capture thread is the
//  only intended caller.
//

import Foundation

final class PhaseVocoderPitchShifter {
  private static let FFT_SIZE = Fft1024.SIZE
  private static let HOP_SIZE = 256
  private static let HALF_FFT = FFT_SIZE / 2
  private static let OLA_GAIN: Float = 1.0 / 1.5

  private let fft = Fft1024()
  private let hann: [Float]

  // Input ring + analysis state.
  private var inputRing: [Float]
  private var inputWritePos: Int = 0
  private var hopCounter: Int = 0

  // Output ring + synthesis state.
  private var outputRing: [Float]
  private var outputReadPos: Int = 0
  private var outputWritePos: Int

  // Per-bin phase tracking.
  private var lastInputPhase: [Float]
  private var sumOutputPhase: [Float]

  // Scratch for analysis/synthesis.
  private var re: [Float]
  private var im: [Float]
  private var magnitude: [Float]
  private var trueFreq: [Float]
  private var newMagnitude: [Float]
  private var newTrueFreq: [Float]

  init() {
    var w = [Float](repeating: 0, count: Self.FFT_SIZE)
    for i in 0..<Self.FFT_SIZE {
      w[i] = Float(0.5 - 0.5 * cos(2.0 * Double.pi * Double(i) / Double(Self.FFT_SIZE)))
    }
    self.hann = w
    self.inputRing = [Float](repeating: 0, count: Self.FFT_SIZE)
    self.outputRing = [Float](repeating: 0, count: Self.FFT_SIZE + Self.HOP_SIZE)
    self.outputWritePos = Self.FFT_SIZE - Self.HOP_SIZE
    self.lastInputPhase = [Float](repeating: 0, count: Self.HALF_FFT + 1)
    self.sumOutputPhase = [Float](repeating: 0, count: Self.HALF_FFT + 1)
    self.re = [Float](repeating: 0, count: Self.FFT_SIZE)
    self.im = [Float](repeating: 0, count: Self.FFT_SIZE)
    self.magnitude = [Float](repeating: 0, count: Self.HALF_FFT + 1)
    self.trueFreq = [Float](repeating: 0, count: Self.HALF_FFT + 1)
    self.newMagnitude = [Float](repeating: 0, count: Self.HALF_FFT + 1)
    self.newTrueFreq = [Float](repeating: 0, count: Self.HALF_FFT + 1)
  }

  /// Filter `n` mono PCM16 samples. Input and output MAY alias.
  /// `factor` > 1 shifts pitch up; < 1 shifts down. Same contract
  /// as `GranularPitchShifter.process(...)`.
  func process(
    input: UnsafePointer<Int16>,
    output: UnsafeMutablePointer<Int16>,
    count n: Int,
    factor: Float
  ) {
    let expectedPhasePerHop = 2.0 * Double.pi * Double(Self.HOP_SIZE) / Double(Self.FFT_SIZE)
    for i in 0..<n {
      // 1) Push input into the ring.
      inputRing[inputWritePos] = Float(input[i]) / 32768.0
      inputWritePos = (inputWritePos + 1) % Self.FFT_SIZE

      // 2) Pull output from the ring; clear the read slot.
      let outSample = outputRing[outputReadPos] * Self.OLA_GAIN
      outputRing[outputReadPos] = 0
      outputReadPos = (outputReadPos + 1) % outputRing.count
      let clamped = max(-1.0, min(1.0, outSample))
      output[i] = Int16(clamped * 32767.0)

      // 3) Every HOP samples, run an analysis+synthesis pass.
      hopCounter += 1
      if hopCounter == Self.HOP_SIZE {
        hopCounter = 0
        analysisAndSynthesis(factor: factor, expectedPhasePerHop: expectedPhasePerHop)
      }
    }
  }

  func reset() {
    for i in 0..<Self.FFT_SIZE { inputRing[i] = 0 }
    for i in 0..<outputRing.count { outputRing[i] = 0 }
    for i in 0..<lastInputPhase.count {
      lastInputPhase[i] = 0
      sumOutputPhase[i] = 0
    }
    inputWritePos = 0
    outputReadPos = 0
    outputWritePos = Self.FFT_SIZE - Self.HOP_SIZE
    hopCounter = 0
  }

  private func analysisAndSynthesis(factor: Float, expectedPhasePerHop: Double) {
    // Copy the latest FFT_SIZE samples from the ring, Hann-windowed.
    // The ring's "oldest" sample is at inputWritePos.
    let start = inputWritePos
    for i in 0..<Self.FFT_SIZE {
      let ringIdx = (start + i) % Self.FFT_SIZE
      re[i] = inputRing[ringIdx] * hann[i]
      im[i] = 0
    }

    fft.forward(&re, &im)

    // Phase tracking + true-frequency derivation for the lower
    // half (Hermitian symmetry on the upper).
    for k in 0...Self.HALF_FFT {
      let r = re[k]
      let ix = im[k]
      let mag = sqrt(r * r + ix * ix)
      let phase = atan2(ix, r)
      let expected = Double(k) * expectedPhasePerHop
      // Wrap deviation to [-π, π].
      var dev = (Double(phase - lastInputPhase[k]) - expected)
        .truncatingRemainder(dividingBy: 2.0 * Double.pi)
      if dev > Double.pi { dev -= 2.0 * Double.pi }
      if dev < -Double.pi { dev += 2.0 * Double.pi }
      let trueFreqCyclesPerSample =
        Double(k) / Double(Self.FFT_SIZE)
        + dev / (2.0 * Double.pi * Double(Self.HOP_SIZE))
      magnitude[k] = mag
      trueFreq[k] = Float(trueFreqCyclesPerSample)
      lastInputPhase[k] = phase
    }

    // Pitch shift: reassign bin k to round(k * factor).
    for k in 0...Self.HALF_FFT {
      newMagnitude[k] = 0
      newTrueFreq[k] = 0
    }
    for k in 0...Self.HALF_FFT {
      let target = Int((Float(k) * factor).rounded())
      if target >= 0 && target <= Self.HALF_FFT {
        if magnitude[k] > newMagnitude[target] {
          newTrueFreq[target] = trueFreq[k] * factor
        }
        newMagnitude[target] += magnitude[k]
      }
    }

    // Reconstruct output spectrum.
    for k in 0...Self.HALF_FFT {
      let advance = 2.0 * Double.pi * Double(newTrueFreq[k]) * Double(Self.HOP_SIZE)
      let next = (Double(sumOutputPhase[k]) + advance).truncatingRemainder(dividingBy: 2.0 * Double.pi)
      sumOutputPhase[k] = Float(next)
      let mag = newMagnitude[k]
      re[k] = mag * cos(sumOutputPhase[k])
      im[k] = mag * sin(sumOutputPhase[k])
    }
    // Hermitian mirror on the upper half for a real IFFT output.
    for k in 1..<Self.HALF_FFT {
      re[Self.FFT_SIZE - k] = re[k]
      im[Self.FFT_SIZE - k] = -im[k]
    }

    fft.inverse(&re, &im)

    // Synthesis window + overlap-add into output ring.
    var w = outputWritePos
    for i in 0..<Self.FFT_SIZE {
      outputRing[w] += re[i] * hann[i]
      w = (w + 1) % outputRing.count
    }
    outputWritePos = (outputWritePos + Self.HOP_SIZE) % outputRing.count
  }
}
