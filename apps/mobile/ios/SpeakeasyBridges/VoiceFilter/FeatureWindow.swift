//
//  FeatureWindow.swift
//  Speakeasy — Phase 5j Private Call (PR-G)
//
//  33ms feature window accumulator + raw-feature computation. Used
//  by SpeakeasyAudioDevice: every captured frame after the
//  SampleFilter runs, mono PCM16 samples accumulate into a
//  fixed-length Float window. When full, we compute loudness (RMS),
//  pitchHz (autocorrelation peak), and zcr (zero-crossing rate),
//  emit them via NotificationCenter, and reset.
//
//  Mirrors the JS-side `audio-feature-extractor.ts` algorithms so
//  the JS smoothing/calibration is feeding genuinely comparable
//  raw features — same RMS, same autocorrelation pitch detector
//  with VOICED_THRESHOLD=0.85 + first-peak-above-threshold bias,
//  same strict-sign ZCR definition.
//

import Foundation

/// Speech pitch range — autocorrelation lag bounds are derived
/// from these. 80–400 Hz covers normal adult speech with margin.
let kFeatureMinPitchHz: Double = 80
let kFeatureMaxPitchHz: Double = 400

/// 33 ms at 48 kHz. The JS side uses the matching constant. Power
/// of 2 isn't required — autocorrelation handles any window size.
let kFeatureWindowSamples: Int = 1600

/// Voiced-segment threshold — autocorrelation values above this
/// count as a real periodic signal. Below: unvoiced fricative /
/// noise / silence; return 0 so the JS follower decays toward 0
/// rather than holding the last detected note.
private let kVoicedThreshold: Float = 0.85

/// RMS noise gate — below this the pitch detector skips outright.
private let kRmsSilenceFloor: Float = 0.02

struct RawFeatureWindow {
  var loudness: Double = 0
  var pitchHz: Double = 0
  var zcr: Double = 0
}

/// Compute raw features on a mono Float [−1, 1] sample window. The
/// caller is responsible for windowing — typically 1600 samples
/// (33 ms @ 48 kHz).
func computeRawFeatures(
  _ samples: UnsafePointer<Float>,
  count n: Int,
  sampleRate: Double
) -> RawFeatureWindow {
  guard n >= 32 else { return RawFeatureWindow() }

  // RMS.
  var sumSq: Float = 0
  for i in 0..<n {
    let s = samples[i]
    sumSq += s * s
  }
  let rms = sqrt(sumSq / Float(n))

  // ZCR — strict-sign crossings, ignore exact zeros. Matches the JS
  // implementation's textbook ZCR definition.
  var crossings = 0
  var prev = samples[0]
  for i in 1..<n {
    let cur = samples[i]
    if (prev > 0 && cur < 0) || (prev < 0 && cur > 0) {
      crossings += 1
    }
    prev = cur
  }
  let zcr = Double(crossings) / Double(n)

  // Pitch via autocorrelation. Skip on near-silence — autocorrelation
  // on noise produces spurious peaks.
  var pitchHz: Double = 0
  if rms >= kRmsSilenceFloor {
    let minLag = Int(sampleRate / kFeatureMaxPitchHz)
    let maxLag = Int(sampleRate / kFeatureMinPitchHz)
    if maxLag < n {
      pitchHz = estimatePitchHz(
        samples, count: n, minLag: minLag, maxLag: maxLag,
        sampleRate: sampleRate)
    }
  }

  return RawFeatureWindow(
    loudness: Double(rms),
    pitchHz: pitchHz,
    zcr: zcr)
}

/// First-peak-above-threshold autocorrelation pitch detector. The
/// algorithm: compute normalized autocorrelation for every lag in
/// [minLag, maxLag], then walk the array in INCREASING lag order
/// (which corresponds to DECREASING frequency) and return the first
/// local maximum whose value exceeds `kVoicedThreshold`. Biases
/// reliably toward the fundamental in voiced speech.
private func estimatePitchHz(
  _ samples: UnsafePointer<Float>,
  count n: Int,
  minLag: Int,
  maxLag: Int,
  sampleRate: Double
) -> Double {
  let lagCount = maxLag - minLag + 1
  if lagCount <= 0 { return 0 }
  var norms = [Float](repeating: 0, count: lagCount)
  for lag in minLag...maxLag {
    var corr: Float = 0
    var energyA: Float = 0
    var energyB: Float = 0
    let end = n - lag
    if end <= 0 { continue }
    for i in 0..<end {
      let a = samples[i]
      let b = samples[i + lag]
      corr += a * b
      energyA += a * a
      energyB += b * b
    }
    let denom = sqrt(energyA * energyB)
    norms[lag - minLag] = denom == 0 ? 0 : corr / denom
  }
  // Find the first local maximum above threshold.
  var bestLag = -1
  for k in 1..<(lagCount - 1) {
    if norms[k] >= kVoicedThreshold
      && norms[k] > norms[k - 1]
      && norms[k] > norms[k + 1] {
      bestLag = k + minLag
      break
    }
  }
  if bestLag <= 0 { return 0 }
  return sampleRate / Double(bestLag)
}
