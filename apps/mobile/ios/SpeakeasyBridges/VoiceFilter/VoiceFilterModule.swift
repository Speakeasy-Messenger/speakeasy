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
    // isAvailable = "iOS can place/accept a private call and it will
    // CONNECT" — true. It does NOT mean the outbound voice is masked: the
    // masking ADM (SpeakeasyAudioDevice) is disabled (build 13, it broke
    // call audio), so wrapTrack is a no-op and the iOS leg rides UNMASKED.
    // That's the prior, working behavior (an unmasked iOS leg + a masked
    // peer). The JS `isOutboundMaskActive()` returns false on iOS so the
    // call UI shows an honest "not masked on this device" indicator instead
    // of pretending. Returning false here (the build-16 fail-safe) instead
    // FAILED the call on accept — killing the only voice-call type on iOS.
    // Flip the honest signal, not this, when masking is genuinely re-hooked
    // (see RE-HOOK.md).
    return ["isAvailable": true]
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

  /// The DSP installed by the most recent `wrapTrack`, retained so a
  /// live `setBypass(false)` can re-engage the same profile after a
  /// reveal. Cleared on `dispose`. (#13 in-call mask toggle.)
  private var currentDsp: SampleFilter?

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

  /// Default pitch + formant shift in semitones. Used when the JS
  /// shim doesn't supply one (legacy callers, tests). Matches the
  /// `velvet` profile in voice-filter-profiles.ts.
  private static let defaultShiftSemitones: Float = -2.0

  @objc(wrapTrack:semitones:formantSemitones:resolver:rejecter:)
  func wrapTrack(_ trackId: String,
                 semitones: NSNumber?,
                 formantSemitones: NSNumber?,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    // rc.17+: semitones arg lets the user pick Smoke/Velvet/Glass
    // from Account → Voice filter.
    // rc.19+: formantSemitones is Phase 2b's independent-formant
    // shift — separates vocal-tract size from pitch height so the
    // 3 profiles get genuinely different voice characters.
    // Both nullable so older JS bundles still work — falls back to
    // pre-2b behavior (formant tied to pitch).
    let shift = semitones?.floatValue ?? Self.defaultShiftSemitones
    let formantShift = formantSemitones?.floatValue ?? 0.0
    let dsp = VoiceFilterDsp(semitones: shift, formantSemitones: formantShift)
    ActiveFilterHolder.shared.set(dsp)
    currentDsp = dsp
    resolve(["filteredTrackId": trackId])
  }

  /// Live mask on/off (#13). `bypassed = true` clears the holder so the
  /// next captured frame goes through UNFILTERED — the user's real voice
  /// reaches the encoder. `false` re-installs the retained DSP. No
  /// re-wrap, no renegotiation: SpeakeasyAudioDevice reads the holder
  /// per frame. Idempotent; a no-op (still resolves) with no active filter.
  @objc(setBypass:resolver:rejecter:)
  func setBypass(_ bypassed: Bool,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    if bypassed {
      ActiveFilterHolder.shared.set(nil)
    } else if let dsp = currentDsp {
      ActiveFilterHolder.shared.set(dsp)
    }
    resolve(nil)
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
    currentDsp = nil
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
