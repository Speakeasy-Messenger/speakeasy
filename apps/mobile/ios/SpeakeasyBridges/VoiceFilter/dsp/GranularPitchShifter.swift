//
//  GranularPitchShifter.swift
//  Speakeasy — Phase 5j Private Call voice filter
//
//  Swift port of
//  apps/mobile/android/.../voicefilter/dsp/GranularPitchShifter.kt
//
//  Tape-head granular pitch shifter — the simplest "voice mask"
//  DSP. Both pitch and formants move by the same factor; that's
//  the locked v1 behavior. A future PR can swap this for an
//  independent pitch + formant shifter (phase vocoder + cepstral
//  whitening) behind the same SampleFilter interface without
//  touching the RTCAudioDevice plumbing.
//
//  Allocation-free per-frame: all buffers sized in init().
//  Not thread-safe; the single AVAudioEngine capture thread is the
//  only intended caller.
//

import Foundation

final class GranularPitchShifter {

  /// `grainSize` must be a positive power of two so the ring-wrap
  /// arithmetic stays a cheap mask. 1024 ≈ 21ms at 48kHz — halved
  /// from the previous 2048 (rc.16 dogfood: filter delay was
  /// pushing end-to-end call latency past the "feels natural"
  /// threshold). Trade-off accepted: more audible granular
  /// crackle at this grain size, especially on sustained vowels.
  /// Phase 2 swaps the algorithm for a phase vocoder which fixes
  /// both — until then, latency is the more painful axis.
  private let grainSize: Int
  /// Cross-fade width in samples. 256 ≈ 5ms at 48kHz.
  private let crossFade: Int

  private let ringSize: Int
  private let ringMask: Int
  private var ring: [Float]

  private var writeIdx: Int = 0
  /// Read head as Double so fractional rates don't drift. Wraps
  /// into [0, ringSize) each frame. Starts diametrically opposite
  /// writeIdx so factor=1 is a clean passthrough (heads stay
  /// `grainSize` apart) and shift factors near 1 push the first
  /// cross-fade lap to ~0.4–0.8s — past the warmup window.
  private var readPos: Double

  init(grainSize: Int = 1024, crossFade: Int = 256) {
    precondition(grainSize > 0 && grainSize & (grainSize - 1) == 0,
                 "grainSize must be a positive power of two")
    precondition(crossFade > 0 && crossFade <= grainSize / 4,
                 "crossFade must be in (0, grainSize/4]")
    self.grainSize = grainSize
    self.crossFade = crossFade
    self.ringSize = grainSize * 2
    self.ringMask = self.ringSize - 1
    self.ring = [Float](repeating: 0, count: ringSize)
    self.readPos = Double(grainSize)
  }

  /// Process `n` mono PCM16 samples through the shifter. `input`
  /// and `output` MAY alias; the ring keeps its own copy.
  func process(
    input: UnsafePointer<Int16>,
    output: UnsafeMutablePointer<Int16>,
    count n: Int,
    factor: Float
  ) {
    // 1) Snapshot input into the ring so the read head never crosses
    // fresh data this frame (avoids self-feedback when input == output).
    var w = writeIdx
    for i in 0..<n {
      ring[w] = Float(input[i]) / 32768.0
      w = (w + 1) & ringMask
    }
    writeIdx = w

    // 2) Render output via the tape head.
    let crossFadeF = Float(crossFade)
    var pos = readPos
    let factorD = Double(factor)
    for i in 0..<n {
      let posI = Int(pos)
      let posF = Float(pos - Double(posI))
      let a0 = posI & ringMask
      let a1 = (posI &+ 1) & ringMask
      let sa = ring[a0] + (ring[a1] - ring[a0]) * posF

      // Grain-back position lags by one grainSize — diametrically
      // opposite read when grainSize = ringSize/2, which it is.
      let bI = posI &- grainSize
      let b0 = bI & ringMask
      let b1 = (bI &+ 1) & ringMask
      let sb = ring[b0] + (ring[b1] - ring[b0]) * posF

      // Forward distance to write head in [0, ringSize).
      let dist = (writeIdx &- posI &- 1 &+ ringSize) & ringMask

      let mix: Float
      if dist < crossFade {
        mix = Float(dist) / crossFadeF
      } else if dist >= ringSize - crossFade {
        mix = Float(ringSize - dist) / crossFadeF
      } else {
        mix = 1.0
      }
      let mixed = sa * mix + sb * (1.0 - mix)

      let clamped = max(-1.0, min(1.0, mixed))
      output[i] = Int16(clamped * 32767.0)

      pos += factorD
      if pos >= Double(ringSize) { pos -= Double(ringSize) }
      if pos < 0 { pos += Double(ringSize) }
    }
    readPos = pos
  }

  func reset() {
    for i in 0..<ringSize { ring[i] = 0 }
    writeIdx = 0
    readPos = Double(grainSize)
  }
}
