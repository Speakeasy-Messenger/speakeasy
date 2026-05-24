//
//  VoiceFilterModule.swift
//  Speakeasy — Phase 5j Private Call native module (iOS side)
//
//  JS contract lives at apps/mobile/src/native/voice-filter.ts.
//  Mirrors apps/mobile/android/.../voicefilter/VoiceFilterModule.kt.
//
//  `wrapTrack` constructs a VoiceFilterDsp and installs it into the
//  process-wide ActiveFilterHolder. The SpeakeasyAudioDevice (set
//  by AppDelegate.mm into WebRTCModuleOptions.audioDevice) reads
//  the holder on every captured frame and mutates the PCM16 in
//  place before pushing to the native ADM via the
//  RTCAudioDeviceDelegate.
//
//  `dispose` clears the holder so the next captured frame goes
//  through unfiltered.
//
//  `isAvailable` stays gated on `#if DEBUG` so the CallTypeSheet's
//  Private row only appears in dev builds. The brand-promise
//  failure-closed posture lives in the JS shim
//  (`isPrivateCallAvailable()`); SpeakeasyAudioDevice mutes the mic
//  on filter-process failure so unfiltered audio never reaches the
//  encoder.
//

import Foundation
import React

@objc(VoiceFilterModule)
final class VoiceFilterModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    #if DEBUG
      return ["isAvailable": true]
    #else
      return ["isAvailable": false]
    #endif
  }

  /// Default pitch + formant shift in semitones. Negative sounds
  /// "deeper" / more disguised; locked v1 plan pick. Matches the
  /// Android-side default in VoiceFilterModule.kt.
  private static let defaultShiftSemitones: Float = -2.0

  @objc(wrapTrack:resolver:rejecter:)
  func wrapTrack(_ trackId: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if DEBUG
      // Same shape as Android: install the DSP into the holder;
      // return the original track id back since the filter wraps
      // the SAMPLES, not the track handle.
      let dsp = VoiceFilterDsp(semitones: Self.defaultShiftSemitones)
      ActiveFilterHolder.shared.set(dsp)
      resolve(["filteredTrackId": trackId])
    #else
      reject("runtime_unavailable", "voice filter not built into release", nil)
    #endif
  }

  @objc(dispose:rejecter:)
  func dispose(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Idempotent. Clearing the holder makes the next captured
    // frame skip the filter. For a `latency_exceeded` mid-call
    // failure the orchestrator ends the call AND calls dispose;
    // SpeakeasyAudioDevice's failure-closed mute-on-fail behavior
    // covers any in-flight frames.
    ActiveFilterHolder.shared.set(nil)
    resolve(nil)
  }
}
