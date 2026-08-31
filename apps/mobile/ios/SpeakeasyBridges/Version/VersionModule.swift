import Foundation

/// iOS counterpart of Android's `VersionModule` (Kotlin). Exposes the
/// app version baked into the bundle to JS as constants, matching the
/// Android module's JS name (`SpeakeasyVersion`) and shape
/// (`versionName`, `versionCode`) so `apps/mobile/src/version.ts`
/// reads both platforms identically — no per-platform branch.
///
/// Source of the values:
///   versionName  <- Info.plist CFBundleShortVersionString
///   versionCode  <- Info.plist CFBundleVersion
///
/// NOTE: on Android these are derived from the git tag at build time
/// (see app/build.gradle `deriveVersionString`). iOS Info.plist values
/// are static until a build step stamps them from the tag — tracked in
/// apps/mobile/ios/HARDENING.md.
@objc(VersionModule)
final class VersionModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    let info = Bundle.main.infoDictionary
    let name = info?["CFBundleShortVersionString"] as? String ?? "unknown"
    let build = info?["CFBundleVersion"] as? String ?? "0"
    return [
      "versionName": name,
      // Android's versionCode is an Int; CFBundleVersion is a string.
      // Emit an Int when it parses so the JS shape matches Android.
      "versionCode": Int(build) ?? 0,
    ]
  }
}

@objc(CallKitReportStore)
final class CallKitReportStore: NSObject {
  private static let key = "SpeakeasyPendingCallKitReports"
  private let defaults: UserDefaults

  @objc init(defaults: UserDefaults) {
    self.defaults = defaults
    super.init()
  }

  @objc(registerCallId:callUUID:at:)
  func register(callId: String, callUUID: String, at: Double) -> [String] {
    var reports = defaults.array(forKey: Self.key) as? [[String: Any]] ?? []
    var removed = reports.filter { report in
      let candidateCallId = report["call_id"] as? String
      let candidateUUID = report["call_uuid"] as? String
      return candidateCallId == callId ||
        candidateUUID?.caseInsensitiveCompare(callUUID) == .orderedSame
    }
    reports.removeAll { report in
      let candidateCallId = report["call_id"] as? String
      let candidateUUID = report["call_uuid"] as? String
      return candidateCallId == callId ||
        candidateUUID?.caseInsensitiveCompare(callUUID) == .orderedSame
    }
    reports.append([
      "call_id": callId,
      "call_uuid": callUUID,
      "at": at,
    ])
    if reports.count > 20 {
      let overflow = reports.count - 20
      removed.append(contentsOf: reports.prefix(overflow))
      reports.removeFirst(overflow)
    }
    defaults.set(reports, forKey: Self.key)

    var seen = Set<String>()
    return removed.compactMap { report in
      guard let uuid = report["call_uuid"] as? String,
            uuid.caseInsensitiveCompare(callUUID) != .orderedSame else {
        return nil
      }
      let normalized = uuid.lowercased()
      return seen.insert(normalized).inserted ? uuid : nil
    }
  }

  func consume(nowMs: Double, maxAgeMs: Double) -> [[String: Any]] {
    let reports = defaults.array(forKey: Self.key) as? [[String: Any]] ?? []
    defaults.removeObject(forKey: Self.key)
    return reports.compactMap { report in
      guard let callUUID = report["call_uuid"] as? String,
            !callUUID.isEmpty else {
        return nil
      }
      let at = report["at"] as? Double
      let expired = at == nil || at! > nowMs || nowMs - at! > maxAgeMs
      var result = report
      result["expired"] = expired
      return result
    }
  }
}

/// Bridgeless-safe handoff for native lifecycle breadcrumbs that can happen
/// while JavaScript is suspended (PushKit, CallKit, and PiP close).
@objc(NativeDiagnosticsModule)
final class NativeDiagnosticsModule: RCTEventEmitter {
  private let defaults = UserDefaults.standard
  private lazy var callKitReports = CallKitReportStore(defaults: defaults)
  private var hasListeners = false

  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(pictureInPictureClosed(_:)),
      name: NSNotification.Name("SpeakeasyPictureInPictureClosed"),
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(callKitReported(_:)),
      name: NSNotification.Name("SpeakeasyCallKitReported"),
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String] {
    ["SpeakeasyPipClosed", "SpeakeasyCallKitReported"]
  }

  override func startObserving() { hasListeners = true }

  override func stopObserving() { hasListeners = false }

  @objc private func pictureInPictureClosed(_ notification: Notification) {
    // Persist before emitting so the live JS callback can atomically consume
    // the fallback without racing AppDelegate's notification observer.
    defaults.set(true, forKey: "SpeakeasyPendingPipClose")
    defaults.set(Date().timeIntervalSince1970, forKey: "SpeakeasyPendingPipCloseAt")
    defaults.set(defaults.string(forKey: "SpeakeasyCurrentPipSession"),
                 forKey: "SpeakeasyPendingPipCloseSession")
    var entries = defaults.array(forKey: "SpeakeasyPendingNativeDiagnostics") as? [[String: Any]] ?? []
    entries.append([
      "at": Date().timeIntervalSince1970 * 1000,
      "message": "iOS PiP closed by user",
    ])
    defaults.set(Array(entries.suffix(50)), forKey: "SpeakeasyPendingNativeDiagnostics")
    if hasListeners { sendEvent(withName: "SpeakeasyPipClosed", body: true) }
  }

  @objc private func callKitReported(_ notification: Notification) {
    guard hasListeners, let report = notification.userInfo else { return }
    sendEvent(withName: "SpeakeasyCallKitReported", body: report)
  }

  @objc func consumePendingCallKitReports(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let nowMs = Date().timeIntervalSince1970 * 1000
    resolve(callKitReports.consume(nowMs: nowMs, maxAgeMs: 120_000))
  }

  @objc func consumePendingPipClose(
    _ sessionId: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let pending = defaults.bool(forKey: "SpeakeasyPendingPipClose")
    let age = Date().timeIntervalSince1970 - defaults.double(forKey: "SpeakeasyPendingPipCloseAt")
    let pendingSession = defaults.string(forKey: "SpeakeasyPendingPipCloseSession")
    defaults.removeObject(forKey: "SpeakeasyPendingPipClose")
    defaults.removeObject(forKey: "SpeakeasyPendingPipCloseAt")
    defaults.removeObject(forKey: "SpeakeasyPendingPipCloseSession")
    resolve(pending && pendingSession == sessionId && age >= 0 && age <= 30)
  }

  @objc func setPipSession(_ sessionId: String?) {
    if let sessionId {
      defaults.set(sessionId, forKey: "SpeakeasyCurrentPipSession")
    } else {
      defaults.removeObject(forKey: "SpeakeasyCurrentPipSession")
    }
  }

  @objc func drainNativeDiagnostics(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let entries = defaults.array(forKey: "SpeakeasyPendingNativeDiagnostics") ?? []
    defaults.removeObject(forKey: "SpeakeasyPendingNativeDiagnostics")
    resolve(entries)
  }
}
