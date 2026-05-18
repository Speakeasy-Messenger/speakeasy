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
