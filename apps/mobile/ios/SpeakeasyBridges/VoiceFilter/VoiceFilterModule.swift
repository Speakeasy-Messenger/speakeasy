//
//  VoiceFilterModule.swift
//  Speakeasy
//
//  Phase 5j iOS — RN bridge for the Private Call voice filter.
//  Mirrors apps/mobile/android/.../voicefilter/VoiceFilterModule.kt
//  in shape: a JS-facing module named `SpeakeasyVoiceFilter` with
//  an `isAvailable` sync constant + async `wrapTrack(trackId)` /
//  `dispose()` methods.
//
//  PR-C — skeleton only. wrapTrack returns the same track id back;
//  no AVAudioEngine graph, no DSP. The real engine + AVAudioSession
//  route-change handling lands in PR-D. This PR exists so the JS
//  shim's bridge round-trip is verified on iOS the same way it is
//  on Android.
//
//  `isAvailable` is gated on `#if DEBUG` so the CallTypeSheet's
//  Private row only appears in dev builds until the founder flips
//  the release flag. The brand-promise failure-closed posture
//  lives in the JS shim (`isPrivateCallAvailable()`).
//
//  Error codes returned via `reject(code, message, error)` must
//  stay in the `FilterErrorCode` union in `voice-filter.ts`. The
//  JS side maps each to a typed `FilterError` the orchestrator
//  switches on.
//

import Foundation
import React

@objc(VoiceFilterModule)
final class VoiceFilterModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    // Dev/debug builds only until PR-D lands the AVAudioEngine DSP
    // and the founder flips the release flag. Release builds stay
    // invisible end-to-end (the JS shim's `isPrivateCallAvailable()`
    // checks this constant).
    #if DEBUG
      return ["isAvailable": true]
    #else
      return ["isAvailable": false]
    #endif
  }

  @objc(wrapTrack:resolver:rejecter:)
  func wrapTrack(_ trackId: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if DEBUG
      // No-op skeleton — return the same track id. PR-D replaces
      // this with the AVAudioEngine tap that intercepts capture
      // samples and feeds them through the DSP before they hit the
      // RTCAudioSource.
      resolve(["filteredTrackId": trackId])
    #else
      reject("runtime_unavailable", "voice filter not built into release", nil)
    #endif
  }

  @objc(dispose:rejecter:)
  func dispose(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Idempotent. Nothing to release yet — PR-D tears down the
    // AVAudioEngine graph and removes the AVAudioSession
    // route-change observer here.
    resolve(nil)
  }
}
