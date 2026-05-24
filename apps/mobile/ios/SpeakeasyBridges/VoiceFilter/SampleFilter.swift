//
//  SampleFilter.swift
//  Speakeasy — Phase 5j Private Call voice filter
//
//  Per-frame interface the DSP exposes to the SpeakeasyAudioDevice
//  capture path. Mirrors the Android-side
//  `xyz.speakeasyapp.app.voicefilter.SampleFilter` contract:
//    - mono or stereo PCM16, interleaved, in-place
//    - allocation-free hot path
//    - returns true when filtered, false on bypass/trip
//
//  The SpeakeasyAudioDevice reads `ActiveFilterHolder.current` on
//  every capture frame and calls `process(...)` if non-nil. On
//  false, it zeroes the buffer (failure-closed brand promise: never
//  send unfiltered audio when the filter was meant to be active)
//  before calling the RTCAudioDeviceDelegate's `deliverRecordedData`.
//

import Foundation

/// Phase 5j Private Call voice-filter contract.
///
/// `process(samples:sampleRateHz:channelCount:)` mutates the PCM16
/// interleaved samples in place and returns whether the frame was
/// actually filtered. Callers (the audio device) MUST treat `false`
/// as a hard failure: mute the buffer and abort the call via the
/// `latency_exceeded` path on the next JS-shim round trip.
protocol SampleFilter: AnyObject {
  func process(
    samples: UnsafeMutablePointer<Int16>,
    frameCount: Int,
    channelCount: Int,
    sampleRateHz: Double
  ) -> Bool
}
