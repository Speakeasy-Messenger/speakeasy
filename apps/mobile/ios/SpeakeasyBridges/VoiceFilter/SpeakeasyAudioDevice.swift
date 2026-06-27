//
//  SpeakeasyAudioDevice.swift
//  Speakeasy — Phase 5j Private Call voice filter
//
//  Custom WebRTC iOS audio device that runs the Phase 5j voice
//  filter on captured audio BEFORE handing it to the native ADM.
//  Installed via `WebRTCModuleOptions.audioDevice` in AppDelegate
//  so every call (audio / video / private) routes through this
//  device. The DSP toggle inside the device is driven by
//  ActiveFilterHolder.
//
//  Architecture:
//
//      ┌──────────────────────────────────────────────────┐
//      │  AVAudioEngine (we own the graph)                │
//      │                                                  │
//      │  inputNode  ──tap──▶  filterIfActive ───┐        │
//      │                                          │        │
//      │  sourceNode  ◀── delegate.getPlayoutData │        │
//      │     │                                    │        │
//      │     └──────────▶ outputNode               │        │
//      └──────────────────────────────────────────│────────┘
//                                                  ▼
//                       delegate.deliverRecordedData (native ADM)
//
//  CallKit cohabitation: AVAudioSession is configured for voice
//  chat mode (.playAndRecord + .voiceChat) — same options CallKit
//  expects. CallKit normally activates the session before recording
//  starts, but a cold launch-to-answer (and the non-CallKit ring
//  path) can call startRecording before activation lands — so
//  installInputTapIfNeeded() defensively activates the session and
//  validates the input format before installing the capture tap.
//  (Handing installTap a not-yet-ready 0 Hz / 0-channel format throws
//  an uncatchable ObjC exception that aborts the app — see that
//  method. Build-10 accept crash, 2026-06-26.)
//
//  Route changes: AVAudioSession.routeChangeNotification triggers
//  notifyAudioInputParametersChange / Output so the native ADM
//  re-reads the sample rate / channel count. The engine is
//  re-started for new-device-available / old-device-unavailable
//  reasons. If the engine fails to restart, the filter holder
//  trips (NotificationCenter posts `.speakeasyVoiceFilterRouteLost`
//  for the orchestrator to observe; PR-E wires this into
//  endWithFilterFailure).
//
//  On-device verification (PR-D test plan): build this PR onto a
//  real iPhone, dial a Private Call, swap mic source mid-call
//  (built-in → AirPods → speaker), observe that the filter
//  survives or surfaces route_lost.
//

import AVFoundation
import Foundation
import WebRTC

/// Posted when a CallKit-style route loss makes the audio engine
/// non-recoverable. PR-E observes this via the JS shim's
/// `latency_exceeded`-equivalent error path. (We re-use the
/// `latency_exceeded` FilterErrorCode rather than introducing a
/// new wire code so PR-E doesn't need to teach the orchestrator a
/// new switch arm; "filter failed for any reason, end the call"
/// is the brand-promise behavior either way.)
extension Notification.Name {
  static let speakeasyVoiceFilterRouteLost =
    Notification.Name("speakeasy.voiceFilter.routeLost")
}

/// `RTCAudioDevice` conformance lives in an extension below — keeping
/// it off the primary declaration prevents the Swift→ObjC generated
/// header (`Speakeasy-Swift.h`) from emitting a forward reference to
/// the WebRTC-defined protocol, which Xcode's auto-import doesn't
/// resolve when `import WebRTC` is only in this file. AppDelegate.mm
/// receives this as a plain `id` and the ObjC runtime dispatches the
/// protocol methods dynamically.
@objc(SpeakeasyAudioDevice)
final class SpeakeasyAudioDevice: NSObject {

  // MARK: - Audio params (read by native ADM)

  @objc var deviceInputSampleRate: Double { AVAudioSession.sharedInstance().sampleRate }
  @objc var deviceOutputSampleRate: Double { AVAudioSession.sharedInstance().sampleRate }
  @objc var inputIOBufferDuration: TimeInterval {
    AVAudioSession.sharedInstance().ioBufferDuration
  }
  @objc var outputIOBufferDuration: TimeInterval {
    AVAudioSession.sharedInstance().ioBufferDuration
  }
  @objc var inputNumberOfChannels: Int {
    Int(AVAudioSession.sharedInstance().inputNumberOfChannels)
  }
  @objc var outputNumberOfChannels: Int {
    Int(AVAudioSession.sharedInstance().outputNumberOfChannels)
  }
  @objc var inputLatency: TimeInterval { AVAudioSession.sharedInstance().inputLatency }
  @objc var outputLatency: TimeInterval { AVAudioSession.sharedInstance().outputLatency }

  // MARK: - Lifecycle state

  @objc private(set) var isInitialized: Bool = false
  @objc private(set) var isPlayoutInitialized: Bool = false
  @objc private(set) var isRecordingInitialized: Bool = false
  @objc private(set) var isPlaying: Bool = false
  @objc private(set) var isRecording: Bool = false

  // MARK: - Internals

  private weak var delegate: RTCAudioDeviceDelegate?
  private let engine = AVAudioEngine()
  private var sourceNode: AVAudioSourceNode?
  private var inputTapInstalled = false
  /// When the input format isn't ready yet (session not active for input),
  /// the tap install is deferred and re-attempted on this schedule rather
  /// than left silently uninstalled. Bounded so a genuinely dead input
  /// route ends the call (route-lost) instead of looping forever.
  private var tapRetryScheduled = false
  private var tapRetryCount = 0
  private static let maxTapRetries = 25 // ~2.5s at the 100ms cadence below
  private var captureScratch: UnsafeMutablePointer<Int16>?
  private var captureScratchCount: Int = 0
  /// Reusable PCM16 buffer for the playout render callback. The render block
  /// runs on the real-time audio thread; it must NEVER malloc/free there (the
  /// allocator can block under memory pressure — e.g. a video call's frame
  /// buffers — stalling the audio thread and shredding the audio). Grow-only,
  /// pre-sized in setupEngineIfNeeded, freed in tearDownEngine after stop().
  private var playoutScratch: UnsafeMutablePointer<Int16>?
  private var playoutScratchCount: Int = 0
  /// Phase 5j PR-G — rolling 33ms (1600-sample at 48kHz) feature
  /// window. Accumulates mono Float samples post-filter; emits a
  /// `.speakeasyVoiceFilterFeatures` notification when full.
  private var featureAccum = [Float](repeating: 0, count: kFeatureWindowSamples)
  private var featureWriteIdx: Int = 0

  // MARK: - RTCAudioDevice

  @objc func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
    self.delegate = delegate
    do {
      try configureAudioSession()
    } catch {
      NSLog("[Speakeasy] audio-session configure failed: %@", String(describing: error))
      return false
    }
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleInterruption(_:)),
      name: AVAudioSession.interruptionNotification,
      object: nil
    )
    isInitialized = true
    return true
  }

  @objc func terminateDevice() -> Bool {
    NotificationCenter.default.removeObserver(self)
    _ = stopPlayout()
    _ = stopRecording()
    tearDownEngine()
    delegate = nil
    isInitialized = false
    return true
  }

  // MARK: - Playout

  @objc func initializePlayout() -> Bool {
    guard isInitialized else { return false }
    isPlayoutInitialized = true
    return true
  }

  @objc func startPlayout() -> Bool {
    guard isPlayoutInitialized, let delegate else { return false }
    if isPlaying { return true }
    do {
      try setupEngineIfNeeded(for: delegate)
      if !engine.isRunning {
        try engine.start()
      }
      isPlaying = true
      return true
    } catch {
      NSLog("[Speakeasy] startPlayout failed: %@", String(describing: error))
      return false
    }
  }

  @objc func stopPlayout() -> Bool {
    guard isPlaying else { return true }
    isPlaying = false
    if !isRecording {
      tearDownEngine()
    }
    return true
  }

  // MARK: - Recording

  @objc func initializeRecording() -> Bool {
    guard isInitialized else { return false }
    isRecordingInitialized = true
    return true
  }

  @objc func startRecording() -> Bool {
    guard isRecordingInitialized, let delegate else { return false }
    if isRecording { return true }
    do {
      try setupEngineIfNeeded(for: delegate)
      try installInputTapIfNeeded()
      if !engine.isRunning {
        try engine.start()
      }
      isRecording = true
      return true
    } catch {
      NSLog("[Speakeasy] startRecording failed: %@", String(describing: error))
      return false
    }
  }

  @objc func stopRecording() -> Bool {
    guard isRecording else { return true }
    if inputTapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      inputTapInstalled = false
    }
    tapRetryCount = 0
    isRecording = false
    if !isPlaying {
      tearDownEngine()
    }
    return true
  }

  // MARK: - Engine setup

  private func configureAudioSession() throws {
    // Match what RTCAudioSessionConfiguration applies for voice
    // chat — same options CallKit expects so route activation
    // through CXProvider's audioSessionDidActivate hook works.
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [
        // .allowBluetoothHFP replaced .allowBluetooth in iOS 8 (the
        // old name is still defined but deprecated in iOS 26+);
        // hands-free profile is what CallKit expects for voice chat.
        .allowBluetoothHFP, .allowBluetoothA2DP, .duckOthers, .defaultToSpeaker,
      ]
    )
    try session.setPreferredSampleRate(48_000)
    try session.setPreferredIOBufferDuration(0.01) // 10ms — WebRTC's standard frame
  }

  private func setupEngineIfNeeded(for delegate: RTCAudioDeviceDelegate) throws {
    if sourceNode != nil { return }

    let outputFormat = engine.mainMixerNode.outputFormat(forBus: 0)
    let playoutSampleRate = outputFormat.sampleRate
    let playoutChannels = AVAudioChannelCount(min(outputFormat.channelCount, 2))

    // Pre-size the playout scratch here (off the audio thread) so the render
    // block never has to allocate. 4800 frames covers the largest IO buffer
    // AVAudioEngine is known to request (100ms @ 48kHz).
    let maxPlayoutInts = 4800 * Int(playoutChannels)
    if playoutScratchCount < maxPlayoutInts {
      if let p = playoutScratch { p.deallocate() }
      playoutScratch = UnsafeMutablePointer<Int16>.allocate(capacity: maxPlayoutInts)
      playoutScratchCount = maxPlayoutInts
    }

    // Pull playout from native ADM via delegate.getPlayoutData.
    // The render block writes interleaved PCM16; we wrap it as a
    // Float32 buffer for AVAudioEngine.
    let renderFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: playoutSampleRate,
      channels: playoutChannels,
      interleaved: false
    )!

    let source = AVAudioSourceNode(format: renderFormat) {
      [weak self] _, timestamp, frameCount, audioBufferList -> OSStatus in
      guard let self, let delegate = self.delegate else {
        // No delegate — emit silence rather than glitch.
        let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
        for buf in abl {
          if let mData = buf.mData {
            memset(mData, 0, Int(buf.mDataByteSize))
          }
        }
        return noErr
      }
      // Reuse a grow-only scratch buffer for the PCM16 the delegate fills —
      // NEVER malloc/free on this real-time render thread (that stalls under
      // allocator pressure and breaks up the audio). Pre-sized in
      // setupEngineIfNeeded; this guard only fires if the host ever asks for a
      // bigger frame than expected.
      let neededInts = Int(frameCount) * Int(playoutChannels)
      if self.playoutScratchCount < neededInts {
        if let p = self.playoutScratch { p.deallocate() }
        self.playoutScratch = UnsafeMutablePointer<Int16>.allocate(capacity: neededInts)
        self.playoutScratchCount = neededInts
      }
      guard let pcm16Scratch = self.playoutScratch else {
        let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
        for buf in abl { if let mData = buf.mData { memset(mData, 0, Int(buf.mDataByteSize)) } }
        return noErr
      }
      let pcm16Bytes = neededInts * MemoryLayout<Int16>.size
      memset(pcm16Scratch, 0, pcm16Bytes)
      var pcm16Buffer = AudioBuffer(
        mNumberChannels: UInt32(playoutChannels),
        mDataByteSize: UInt32(pcm16Bytes),
        mData: UnsafeMutableRawPointer(pcm16Scratch))
      var pcm16Abl = AudioBufferList(mNumberBuffers: 1, mBuffers: pcm16Buffer)

      var flags = AudioUnitRenderActionFlags(rawValue: 0)
      let status = delegate.getPlayoutData(
        &flags, timestamp, /* inputBusNumber */ 0, frameCount, &pcm16Abl)
      if status != noErr {
        // Native ADM had nothing for us — silence.
        let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
        for buf in abl {
          if let mData = buf.mData {
            memset(mData, 0, Int(buf.mDataByteSize))
          }
        }
        return noErr
      }
      // Convert PCM16 interleaved → Float32 deinterleaved into the
      // AVAudioEngine output buffer list.
      let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
      let pcm16 = pcm16Buffer.mData!.assumingMemoryBound(to: Int16.self)
      for ch in 0..<Int(playoutChannels) {
        guard ch < abl.count, let dst = abl[ch].mData else { continue }
        let f32 = dst.assumingMemoryBound(to: Float32.self)
        for i in 0..<Int(frameCount) {
          let s = pcm16[i * Int(playoutChannels) + ch]
          f32[i] = Float32(s) / 32768.0
        }
      }
      return noErr
    }
    engine.attach(source)
    engine.connect(source, to: engine.mainMixerNode, format: renderFormat)
    sourceNode = source
  }

  private func installInputTapIfNeeded() throws {
    if inputTapInstalled { return }
    guard delegate != nil else { return }

    // `inputNode.outputFormat(forBus:0)` returns a degenerate 0 Hz /
    // 0-channel format until the AVAudioSession is active *with a live
    // input route*. Handing that format to `installTap` throws an
    // uncatchable ObjC NSException (the CoreAudio
    // `IsFormatSampleRateAndChannelCountValid(format)` assertion) which
    // `abort()`s the whole process — this was the call-accept crash on
    // asiangamble's iPhone (build 10, SIGABRT in
    // -[AVAudioNode installTapOnBus:]). The header note above assumed
    // CallKit always activates the session before startRecording, but a
    // cold launch-to-answer (and the non-CallKit ring path) races that
    // activation, so the format isn't ready yet. Force the session
    // active, re-read, and *never* install a tap with an invalid format.
    var inputFormat = engine.inputNode.outputFormat(forBus: 0)
    if !SpeakeasyAudioDevice.isUsableFormat(inputFormat) {
      try? AVAudioSession.sharedInstance().setActive(true)
      inputFormat = engine.inputNode.outputFormat(forBus: 0)
    }
    guard SpeakeasyAudioDevice.isUsableFormat(inputFormat) else {
      // Input route still unresolved (mid device-switch, session not yet
      // active, mic not granted). Don't throw and don't install a bad
      // tap (that aborts the process) — schedule a retry so the mic
      // capture actually comes up a beat later instead of leaving the
      // call permanently one-way-silent.
      NSLog(
        "[Speakeasy] input format not ready (rate=%f ch=%u) — retry %d/%d",
        inputFormat.sampleRate, inputFormat.channelCount,
        tapRetryCount, SpeakeasyAudioDevice.maxTapRetries)
      scheduleTapRetry()
      return
    }

    let sampleRate = inputFormat.sampleRate
    let channelCount = min(Int(inputFormat.channelCount), 2)

    // 10ms IO buffer at the negotiated rate. AVAudioEngine may
    // request 4800-sample buffers; the audio device collapses them
    // into 10ms chunks for the native ADM.
    let bufferSize = AVAudioFrameCount(sampleRate * 0.01)

    engine.inputNode.installTap(
      onBus: 0, bufferSize: bufferSize, format: inputFormat
    ) { [weak self] buffer, time in
      guard let self else { return }
      self.handleCapturedBuffer(buffer, time: time, sampleRate: sampleRate, channels: channelCount)
    }
    inputTapInstalled = true
    tapRetryCount = 0
  }

  /// An AVAudioFormat is only safe to hand to `installTap` when both its
  /// sample rate and channel count are non-zero — otherwise CoreAudio's
  /// `IsFormatSampleRateAndChannelCountValid` assertion throws an
  /// uncatchable ObjC exception that aborts the app.
  private static func isUsableFormat(_ format: AVAudioFormat) -> Bool {
    format.sampleRate > 0 && format.channelCount > 0
  }

  /// Re-attempt the input tap install ~100ms later (on the ADM thread,
  /// where the route-change restart also installs it). Bounded: once the
  /// budget is exhausted we surface route-lost so the call ends cleanly
  /// rather than running on with a dead mic.
  private func scheduleTapRetry() {
    if tapRetryScheduled { return }
    if tapRetryCount >= SpeakeasyAudioDevice.maxTapRetries {
      NSLog("[Speakeasy] input never became ready — ending call (route lost)")
      NotificationCenter.default.post(name: .speakeasyVoiceFilterRouteLost, object: self)
      return
    }
    tapRetryScheduled = true
    tapRetryCount += 1
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      guard let self else { return }
      self.tapRetryScheduled = false
      // Only still relevant if we're meant to be capturing and haven't.
      guard self.isRecording, !self.inputTapInstalled, self.delegate != nil else { return }
      self.delegate?.dispatchAsync { [weak self] in
        guard let self else { return }
        do { try self.installInputTapIfNeeded() } catch {
          NSLog("[Speakeasy] tap retry failed: %@", String(describing: error))
        }
      }
    }
  }

  /// Convert the Float32 deinterleaved capture buffer to PCM16
  /// interleaved, run the filter if active, then hand off to
  /// `delegate.deliverRecordedData`.
  private func handleCapturedBuffer(
    _ buffer: AVAudioPCMBuffer,
    time: AVAudioTime,
    sampleRate: Double,
    channels: Int
  ) {
    let frameCount = Int(buffer.frameLength)
    guard frameCount > 0, let floatChannels = buffer.floatChannelData else { return }

    // Ensure scratch is sized for this frame.
    let neededInts = frameCount * channels
    if captureScratchCount < neededInts {
      if let p = captureScratch { p.deallocate() }
      captureScratch = UnsafeMutablePointer<Int16>.allocate(capacity: neededInts)
      captureScratchCount = neededInts
    }
    guard let scratch = captureScratch else { return }

    // Float32 deinterleaved → PCM16 interleaved.
    for i in 0..<frameCount {
      for ch in 0..<channels {
        let f = floatChannels[ch][i]
        let clamped = max(-1.0, min(1.0, f))
        scratch[i * channels + ch] = Int16(clamped * 32767.0)
      }
    }

    // If filter is active, run it. On false → zero the buffer
    // (failure-closed) and post route-lost so PR-E ends the call.
    if let filter = ActiveFilterHolder.shared.get() {
      let ok = filter.process(
        samples: scratch,
        frameCount: frameCount,
        channelCount: channels,
        sampleRateHz: sampleRate)
      if !ok {
        memset(scratch, 0, neededInts * MemoryLayout<Int16>.size)
        NotificationCenter.default.post(
          name: .speakeasyVoiceFilterRouteLost, object: self)
      } else {
        // Phase 5j PR-G — accumulate filtered mono samples into the
        // feature window. VoiceFilterDsp collapses stereo→mono and
        // writes the same mono value to both channels, so reading
        // `scratch[i * channels]` works regardless of channel count.
        accumulateFeatureSamples(
          scratch: scratch, frameCount: frameCount, channels: channels,
          sampleRate: sampleRate)
      }
    }

    // Hand to native ADM via the delegate. We build an
    // AudioBufferList around the scratch.
    var ioFlags = AudioUnitRenderActionFlags(rawValue: 0)
    var ts = time.audioTimeStamp
    var inputAbl = AudioBufferList(
      mNumberBuffers: 1,
      mBuffers: AudioBuffer(
        mNumberChannels: UInt32(channels),
        mDataByteSize: UInt32(neededInts * MemoryLayout<Int16>.size),
        mData: UnsafeMutableRawPointer(scratch)
      ))

    _ = delegate?.deliverRecordedData(
      &ioFlags, &ts, /* inputBusNumber */ 0,
      AVAudioFrameCount(frameCount),
      &inputAbl,
      nil, // renderContext
      nil  // renderBlock (we already have the data filled)
    )
  }

  /// Append mono samples (post-filter, PCM16) into the rolling
  /// 33ms feature window. When full: compute RMS / pitchHz / ZCR
  /// and post `.speakeasyVoiceFilterFeatures`. VoiceFilterModule
  /// observes that notification and re-emits to JS as
  /// `SpeakeasyVoiceFilterFeatures` for the orchestrator to pack
  /// into an AnimationFrame.
  private func accumulateFeatureSamples(
    scratch: UnsafeMutablePointer<Int16>,
    frameCount: Int,
    channels: Int,
    sampleRate: Double
  ) {
    for i in 0..<frameCount {
      // VoiceFilterDsp mirrors L==R for stereo, so this is mono
      // regardless of channel count.
      let s = Float(scratch[i * channels]) / 32768.0
      featureAccum[featureWriteIdx] = s
      featureWriteIdx += 1
      if featureWriteIdx >= kFeatureWindowSamples {
        emitFeatureWindow(sampleRate: sampleRate)
        featureWriteIdx = 0
      }
    }
  }

  private func emitFeatureWindow(sampleRate: Double) {
    let raw = featureAccum.withUnsafeBufferPointer { buf -> RawFeatureWindow in
      guard let base = buf.baseAddress else { return RawFeatureWindow() }
      return computeRawFeatures(
        base, count: kFeatureWindowSamples, sampleRate: sampleRate)
    }
    NotificationCenter.default.post(
      name: .speakeasyVoiceFilterFeatures,
      object: self,
      userInfo: [
        "loudness": raw.loudness,
        "pitchHz": raw.pitchHz,
        "zcr": raw.zcr,
        "sampleRate": sampleRate,
      ])
  }

  private func tearDownEngine() {
    if engine.isRunning {
      engine.stop()
    }
    if let source = sourceNode {
      engine.disconnectNodeOutput(source)
      engine.detach(source)
      sourceNode = nil
    }
    if let p = captureScratch {
      p.deallocate()
      captureScratch = nil
      captureScratchCount = 0
    }
    // Safe to free here: engine.stop() above guarantees the render block is
    // no longer running, so nothing on the audio thread can touch it.
    if let p = playoutScratch {
      p.deallocate()
      playoutScratch = nil
      playoutScratchCount = 0
    }
  }

  // MARK: - Route changes

  @objc private func handleRouteChange(_ notification: Notification) {
    guard let info = notification.userInfo,
      let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
    else { return }

    switch reason {
    case .newDeviceAvailable, .oldDeviceUnavailable, .categoryChange,
      .override, .routeConfigurationChange:
      // Restart the engine on the ADM thread so the audio params
      // are re-published before the next frame fires.
      delegate?.dispatchAsync { [weak self] in
        guard let self else { return }
        let wasRecording = self.isRecording
        let wasPlaying = self.isPlaying
        if self.engine.isRunning { self.engine.stop() }
        if self.inputTapInstalled {
          self.engine.inputNode.removeTap(onBus: 0)
          self.inputTapInstalled = false
        }
        self.tapRetryCount = 0
        self.sourceNode = nil
        do {
          if let delegate = self.delegate {
            try self.setupEngineIfNeeded(for: delegate)
            if wasRecording {
              try self.installInputTapIfNeeded()
            }
            if wasRecording || wasPlaying {
              try self.engine.start()
            }
          }
          // Notify native ADM that input/output params may have
          // changed so it re-reads our properties.
          self.delegate?.notifyAudioInputParametersChange()
          self.delegate?.notifyAudioOutputParametersChange()
        } catch {
          NSLog("[Speakeasy] route-change restart failed: %@", String(describing: error))
          NotificationCenter.default.post(
            name: .speakeasyVoiceFilterRouteLost, object: self)
        }
      }
    case .wakeFromSleep, .unknown, .noSuitableRouteForCategory:
      break
    @unknown default:
      break
    }
  }

  @objc private func handleInterruption(_ notification: Notification) {
    guard let info = notification.userInfo,
      let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    switch type {
    case .began:
      delegate?.notifyAudioInputInterrupted()
      delegate?.notifyAudioOutputInterrupted()
    case .ended:
      delegate?.dispatchAsync { [weak self] in
        guard let self else { return }
        if !self.engine.isRunning && (self.isRecording || self.isPlaying) {
          try? self.engine.start()
        }
      }
    @unknown default:
      break
    }
  }

  // MARK: - dispatchAsync / dispatchSync helpers
  //
  // The RTCAudioDeviceDelegate API surface provides dispatchAsync /
  // dispatchSync that we use ABOVE to marshal restart work onto the
  // ADM thread. The DEVICE side of the protocol doesn't need to
  // expose any custom queues — `engine` does its own thread
  // management for AVAudioSourceNode + inputTap callbacks.

  deinit {
    NotificationCenter.default.removeObserver(self)
    if let p = captureScratch { p.deallocate() }
    if let p = playoutScratch { p.deallocate() }
  }
}

// MARK: - RTCAudioDevice conformance (extension so the protocol
// reference doesn't leak into Speakeasy-Swift.h)
extension SpeakeasyAudioDevice: RTCAudioDevice {}
