//
//  VoiceFilterDsp.swift
//  Speakeasy — Phase 5j Private Call voice filter
//
//  Swift port of
//  apps/mobile/android/.../voicefilter/dsp/VoiceFilterDsp.kt
//
//  Top-level filter: configurable pitch + formant shift in
//  semitones (default −2; sounds "deeper", more disguised), 120ms
//  p95 latency budget, mono PCM16. Stereo handled by the caller
//  (the audio device collapses stereo→mono BEFORE calling
//  process(...) to avoid duplicate work in the granular shifter).
//
//  Allocation-free per-frame: scratch sized for the largest
//  plausible frame in init().
//

import Foundation

final class VoiceFilterDsp: SampleFilter {

  /// Phase 2a default — flip to `false` to revert to the rc.17
  /// granular shifter if field testing finds the vocoder worse.
  private static let USE_PHASE_VOCODER: Bool = true

  private let factor: Float
  private let formantFactor: Float
  private let shifter: PitchShifter
  private let guardrail: LatencyGuard
  private let nowMicros: () -> Int64

  /// Cached sample-rate so we can detect mid-call reconfigs (e.g.,
  /// route changes) and reset the shifter ring buffer cleanly.
  private var lastSampleRate: Double = 0
  /// Cached channel count for diagnostics; current shifter is mono
  /// only — the audio device collapses stereo→mono upstream.
  private(set) var lastChannelCount: Int = 0

  init(
    semitones: Float = -2.0,
    formantSemitones: Float = 0.0,
    budgetMicros: Int64 = 120_000,
    nowMicros: @escaping () -> Int64 = {
      Int64(DispatchTime.now().uptimeNanoseconds / 1_000)
    }
  ) {
    self.factor = pow(2.0, semitones / 12.0)
    self.formantFactor = pow(2.0, formantSemitones / 12.0)
    // Phase 2a: phase vocoder by default. Lower latency (~10ms vs
    // ~21ms) and no crackle, at the cost of some pitch-shift
    // artifacts on transients and faint metallic edge on sustained
    // vowels. The boolean above lets us flip back to granular if
    // field testing finds the vocoder worse on real hardware.
    // Phase 2b: vocoder gets formantFactor for independent
    // pitch/formant control. Granular ignores it (can't do it).
    self.shifter = Self.USE_PHASE_VOCODER
      ? PhaseVocoderShifterAdapter(formantFactor: self.formantFactor)
      : GranularShifterAdapter()
    self.guardrail = LatencyGuard(budgetMicros: budgetMicros)
    self.nowMicros = nowMicros
  }

  func process(
    samples: UnsafeMutablePointer<Int16>,
    frameCount: Int,
    channelCount: Int,
    sampleRateHz: Double
  ) -> Bool {
    if guardrail.isTripped() { return false }
    guard channelCount == 1 || channelCount == 2 else { return false }
    if frameCount <= 0 { return false }
    if frameCount > Self.maxFrameSamples { return false }

    lastChannelCount = channelCount
    if lastSampleRate != sampleRateHz {
      lastSampleRate = sampleRateHz
      shifter.reset()
    }

    let start = nowMicros()
    if channelCount == 1 {
      shifter.process(input: samples, output: samples, count: frameCount, factor: factor)
    } else {
      // Stereo path: collapse to mono into a scratch, shift, then
      // duplicate mono back to L and R. The audio device collapses
      // BEFORE calling us when it can; this branch is a safety net.
      var mono = [Int16](repeating: 0, count: frameCount)
      for i in 0..<frameCount {
        let l = Int32(samples[i * 2])
        let r = Int32(samples[i * 2 + 1])
        mono[i] = Int16((l + r) >> 1)
      }
      mono.withUnsafeMutableBufferPointer { buf in
        guard let base = buf.baseAddress else { return }
        shifter.process(input: base, output: base, count: frameCount, factor: factor)
      }
      for i in 0..<frameCount {
        samples[i * 2] = mono[i]
        samples[i * 2 + 1] = mono[i]
      }
    }
    let elapsed = nowMicros() - start
    guardrail.recordFrame(elapsedMicros: elapsed)
    return true
  }

  /// Diagnostics; do not gate behavior. The audio device queries
  /// this after a `process(...)=false` to decide whether to emit
  /// `latency_exceeded` to the JS shim's wrapTrack rejection.
  func isLatencyTripped() -> Bool { guardrail.isTripped() }

  func shiftFactor() -> Float { factor }

  func reset() {
    shifter.reset()
    guardrail.reset()
    lastSampleRate = 0
  }

  /// 60ms at 48kHz mono — same headroom as the Android DSP.
  /// WebRTC standard frame is 10ms (480 samples at 48kHz); 6×
  /// margin keeps us safe if a future RTCAudioDevice configuration
  /// bumps to a longer IO buffer.
  static let maxFrameSamples = 2880
}

/// Common shape so [VoiceFilterDsp] can hold either shifter.
protocol PitchShifter {
  func process(
    input: UnsafePointer<Int16>,
    output: UnsafeMutablePointer<Int16>,
    count: Int,
    factor: Float
  )
  func reset()
}

final class GranularShifterAdapter: PitchShifter {
  private let inner = GranularPitchShifter()
  func process(
    input: UnsafePointer<Int16>,
    output: UnsafeMutablePointer<Int16>,
    count: Int,
    factor: Float
  ) {
    inner.process(input: input, output: output, count: count, factor: factor)
  }
  func reset() { inner.reset() }
}

final class PhaseVocoderShifterAdapter: PitchShifter {
  private let inner: PhaseVocoderPitchShifter
  init(formantFactor: Float = 1.0) {
    self.inner = PhaseVocoderPitchShifter(formantFactor: formantFactor)
  }
  func process(
    input: UnsafePointer<Int16>,
    output: UnsafeMutablePointer<Int16>,
    count: Int,
    factor: Float
  ) {
    inner.process(input: input, output: output, count: count, factor: factor)
  }
  func reset() { inner.reset() }
}
