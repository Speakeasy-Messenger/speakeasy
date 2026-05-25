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
//  Phase 5j PR-G — feature event emission. SpeakeasyAudioDevice
//  posts `Notification.Name.speakeasyVoiceFilterFeatures` whenever
//  it has a fresh 33ms feature window (loudness, pitchHz, zcr).
//  This module observes that notification and re-emits it as the
//  RN event `SpeakeasyVoiceFilterFeatures`, which the JS-side
//  `attachFeatureEventListener` consumes to pack into an
//  AnimationFrame over the WebRTC data channel.
//

import Foundation
import React

@objc(VoiceFilterModule)
final class VoiceFilterModule: RCTEventEmitter {

  /// Single event name; constants live in JS as well so the two
  /// sides stay in sync via grep, not a generated header.
  private static let kFeaturesEvent = "SpeakeasyVoiceFilterFeatures"

  // MARK: - RCTBridgeModule

  override static func requiresMainQueueSetup() -> Bool { return false }

  override func constantsToExport() -> [AnyHashable: Any]! {
    #if DEBUG
      return ["isAvailable": true]
    #else
      return ["isAvailable": false]
    #endif
  }

  // MARK: - RCTEventEmitter

  override func supportedEvents() -> [String] {
    return [Self.kFeaturesEvent]
  }

  /// Whether JS has at least one listener registered. Tracking
  /// this lets us avoid the post-notification → bridge-call cost
  /// when nobody is listening (the Private Call isn't active, or
  /// the receiver hasn't subscribed yet).
  private var hasListeners = false

  override func startObserving() {
    hasListeners = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleFeaturesNotification(_:)),
      name: .speakeasyVoiceFilterFeatures,
      object: nil
    )
  }

  override func stopObserving() {
    hasListeners = false
    NotificationCenter.default.removeObserver(
      self,
      name: .speakeasyVoiceFilterFeatures,
      object: nil
    )
  }

  @objc private func handleFeaturesNotification(_ notification: Notification) {
    guard hasListeners,
      let info = notification.userInfo,
      let loudness = info["loudness"] as? Double,
      let pitchHz = info["pitchHz"] as? Double,
      let zcr = info["zcr"] as? Double,
      let sampleRate = info["sampleRate"] as? Double
    else { return }
    sendEvent(
      withName: Self.kFeaturesEvent,
      body: [
        "loudness": loudness,
        "pitchHz": pitchHz,
        "zcr": zcr,
        "sampleRate": sampleRate,
      ])
  }

  // MARK: - JS-callable methods

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

extension Notification.Name {
  /// Posted by SpeakeasyAudioDevice after the SampleFilter runs on
  /// a fresh 33ms feature window. userInfo: ["loudness": Double,
  /// "pitchHz": Double, "zcr": Double, "sampleRate": Double].
  static let speakeasyVoiceFilterFeatures =
    Notification.Name("speakeasy.voiceFilter.features")
}
