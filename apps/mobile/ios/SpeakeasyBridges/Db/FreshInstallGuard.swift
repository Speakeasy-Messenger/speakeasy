//
//  FreshInstallGuard.swift
//  Speakeasy
//
//  Makes "reinstall = fresh start" TRUE on iOS.
//
//  # The bug this closes
//
//  iOS Keychain items SURVIVE app deletion (unlike the app container).
//  DbKeyStore's header comment asserted the opposite ("does not survive
//  uninstall, which is the intended policy") — that assumption is simply
//  wrong on iOS, and Android's backup_rules.xml documents the intended
//  policy plainly: "reinstall = full re-onboard. Same posture as Signal/
//  WhatsApp."
//
//  Consequences observed 2026-08-07 (@sweetgarlicpie): the user deleted
//  and reinstalled the app. The app container — including the SQLCipher
//  Signal store with their identity private key — was gone, so the app
//  minted a NEW Signal identity. But the Vouchflow device token survived
//  in the Keychain, so the server still resolved that token to the old
//  handle. The account came back WITHOUT passing /v1/enroll or
//  /v1/devices/rebind — the only two endpoints that enforce identity
//  continuity — and the fresh identity silently attached to the old
//  account. Every peer then saw "[identity changed — verify with peer]"
//  and calls died on UntrustedIdentityException.
//
//  The server now rejects that attachment (prekey uploads must be signed
//  by the on-file identity). This side fixes the cause: a reinstall must
//  not inherit ANY credential material.
//
//  # How the fresh-install test works
//
//  UserDefaults lives in the app container, so it IS destroyed on
//  uninstall. A sentinel there means "this install has run before".
//
//    sentinel present            → normal launch, do nothing.
//    sentinel absent + DB exists → EXISTING install upgrading to a build
//                                  that has this guard. Adopt it: write
//                                  the sentinel, purge NOTHING. Without
//                                  this branch, shipping the guard would
//                                  log out every existing user exactly
//                                  once — the DB file (also container-
//                                  scoped) is the proof they're not fresh.
//    sentinel absent + no DB     → genuine fresh install. Purge any
//                                  surviving Keychain credentials so
//                                  onboarding starts from zero.
//
//  Both branches are idempotent and cheap; this runs once per process at
//  launch, before the RN bridge starts.
//

import Foundation
import Security

@objc(FreshInstallGuard)
public final class FreshInstallGuard: NSObject {

    private static let sentinelKey = "xyz.speakeasyapp.install.sentinel-v1"

    /// Every Keychain class the purge sweeps. We delete by CLASS rather
    /// than by service name deliberately: iOS scopes Keychain visibility
    /// to the app's own access group, so an unfiltered delete removes
    /// exactly this app's items and nothing else — and it cannot miss a
    /// credential because someone added a new service name (the Vouchflow
    /// SDK owns its own item names, which are not ours to track).
    private static let purgedClasses: [CFString] = [
        kSecClassGenericPassword,
        kSecClassInternetPassword,
        kSecClassCertificate,
        kSecClassKey,
        kSecClassIdentity,
    ]

    /// What `evaluate` decided — surfaced for tests and log forensics.
    @objc public enum Decision: Int {
        /// Sentinel already present: this install has launched before.
        case alreadyInitialized
        /// No sentinel but a DB exists: pre-guard install, adopted as-is.
        case adoptedExistingInstall
        /// No sentinel, no DB: genuine fresh install — Keychain purged.
        case purgedFreshInstall
    }

    /// Run BEFORE any Keychain/DB consumer touches state (AppDelegate
    /// didFinishLaunching, ahead of the RN bridge).
    @objc @discardableResult
    public static func runAtLaunch() -> Decision {
        evaluate(defaults: UserDefaults.standard, databaseExists: databaseExists())
    }

    /// Decision core, with the two environment inputs injected so tests
    /// can drive every branch against a REAL Keychain without touching
    /// the app's own defaults or database.
    @discardableResult
    static func evaluate(defaults: UserDefaults, databaseExists: Bool) -> Decision {
        if defaults.bool(forKey: sentinelKey) {
            return .alreadyInitialized
        }
        if databaseExists {
            // Existing install predating this guard — adopt, don't purge.
            NSLog("[FreshInstallGuard] existing install adopted (db present); no purge")
            defaults.set(true, forKey: sentinelKey)
            return .adoptedExistingInstall
        }
        let purged = purgeKeychain()
        NSLog("[FreshInstallGuard] fresh install — purged \(purged) keychain class(es)")
        defaults.set(true, forKey: sentinelKey)
        return .purgedFreshInstall
    }

    /// True when the SQLCipher store exists in the (container-scoped)
    /// Application Support directory.
    private static func databaseExists() -> Bool {
        guard
            let docs = try? FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: false
            )
        else {
            return false
        }
        return FileManager.default.fileExists(
            atPath: docs.appendingPathComponent("speakeasy.db").path
        )
    }

    /// Delete every Keychain item this app can see. Returns the number of
    /// classes whose delete reported success (i.e. held something).
    @discardableResult
    private static func purgeKeychain() -> Int {
        var deleted = 0
        for itemClass in purgedClasses {
            let status = SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
            if status == errSecSuccess {
                deleted += 1
            } else if status != errSecItemNotFound {
                // Non-fatal: a locked Keychain (-25308) right at launch
                // leaves items in place. The sentinel is still written, so
                // this doesn't retry-loop; a surviving token now fails
                // SAFELY server-side (prekey uploads must be signed by the
                // on-file identity) rather than silently taking over an
                // account.
                NSLog("[FreshInstallGuard] purge of class \(itemClass) failed: OSStatus \(status)")
            }
        }
        return deleted
    }
}
