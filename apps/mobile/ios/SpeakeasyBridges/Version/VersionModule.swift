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

/// Bridgeless-safe handoff for native lifecycle breadcrumbs that can happen
/// while JavaScript is suspended (PushKit, CallKit, and PiP close).
@objc(NativeDiagnosticsModule)
final class NativeDiagnosticsModule: RCTEventEmitter {
  private let defaults = UserDefaults.standard
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
    let key = "SpeakeasyPendingCallKitReports"
    let nowMs = Date().timeIntervalSince1970 * 1000
    let reports = (defaults.array(forKey: key) as? [[String: Any]] ?? []).filter { report in
      guard let at = report["at"] as? Double else { return false }
      return at <= nowMs && nowMs - at <= 120_000
    }
    defaults.removeObject(forKey: key)
    resolve(reports)
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
