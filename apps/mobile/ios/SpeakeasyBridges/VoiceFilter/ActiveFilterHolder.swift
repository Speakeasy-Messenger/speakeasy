//
//  ActiveFilterHolder.swift
//  Speakeasy — Phase 5j Private Call voice filter
//
//  Process-wide holder for the currently-active voice filter on
//  capture audio. Mirrors the Android-side
//  `xyz.speakeasyapp.app.voicefilter.ActiveFilterHolder` contract:
//  the audio device reads on every capture frame, VoiceFilterModule
//  writes when JS calls `wrapTrack` / `dispose`.
//
//  Atomic via an internal serial queue. Reads from the audio thread
//  are lock-free except during the brief swap window.
//

import Foundation

final class ActiveFilterHolder {
  static let shared = ActiveFilterHolder()
  private init() {}

  /// `os_unfair_lock` would be lighter, but for one-pointer load on
  /// the audio thread the cost is dominated by AVAudioEngine's own
  /// queue overhead. A serial queue is plenty.
  private let lock = NSLock()
  private var _current: SampleFilter?

  func get() -> SampleFilter? {
    lock.lock()
    defer { lock.unlock() }
    return _current
  }

  func set(_ filter: SampleFilter?) {
    lock.lock()
    _current = filter
    lock.unlock()
  }
}
