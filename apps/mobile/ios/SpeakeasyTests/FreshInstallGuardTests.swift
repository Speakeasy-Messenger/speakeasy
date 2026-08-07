//
//  FreshInstallGuardTests.swift
//  SpeakeasyTests
//
//  Exercises FreshInstallGuard against a REAL Keychain (simulator or
//  device), which is the only place its behaviour is meaningful — the
//  bug it fixes exists precisely because iOS Keychain semantics differ
//  from the app container's.
//
//  Covers all three branches, and in particular the one whose failure
//  mode is worst on ship day: `adoptedExistingInstall` must NOT purge,
//  or every existing user is logged out exactly once by the upgrade.
//

import XCTest
import Security
@testable import Speakeasy

final class FreshInstallGuardTests: XCTestCase {

    private let probeService = "xyz.speakeasyapp.freshinstallguard.probe"
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        // Isolated defaults per test — never the app's standard suite.
        suiteName = "FreshInstallGuardTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        seedProbeKeychainItem()
    }

    override func tearDownWithError() throws {
        deleteProbeKeychainItem()
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
        defaults = nil
    }

    // MARK: - Probe helpers

    /// A Keychain item standing in for the credentials that survive an
    /// app delete (Vouchflow device token, DbKeyStore root secret).
    private func seedProbeKeychainItem() {
        deleteProbeKeychainItem()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: probeService,
            kSecAttrAccount as String: "probe",
            kSecValueData as String: Data("surviving-token".utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        XCTAssertEqual(status, errSecSuccess, "probe seed failed: \(status)")
    }

    private func probeKeychainItemExists() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: probeService,
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess
    }

    private func deleteProbeKeychainItem() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: probeService,
        ] as CFDictionary)
    }

    // MARK: - Branches

    /// Genuine fresh install: no sentinel, no database. Surviving
    /// Keychain credentials must be destroyed — this is the reinstall
    /// that used to inherit a device token and resurrect the account
    /// under a brand-new Signal identity.
    func testFreshInstallPurgesSurvivingKeychainItems() {
        XCTAssertTrue(probeKeychainItemExists(), "precondition: probe present")

        let decision = FreshInstallGuard.evaluate(defaults: defaults, databaseExists: false)

        XCTAssertEqual(decision, .purgedFreshInstall)
        XCTAssertFalse(probeKeychainItemExists(), "surviving credential must be purged")
    }

    /// Existing install upgrading onto this build: no sentinel yet, but
    /// the container-scoped database proves it isn't fresh. Purging here
    /// would sign out every current user on upgrade.
    func testExistingInstallIsAdoptedAndKeychainPreserved() {
        let decision = FreshInstallGuard.evaluate(defaults: defaults, databaseExists: true)

        XCTAssertEqual(decision, .adoptedExistingInstall)
        XCTAssertTrue(probeKeychainItemExists(), "existing install must NOT be purged")
    }

    /// Normal launch: the sentinel is set, so the guard is inert — no
    /// Keychain access at all, whatever the database looks like.
    func testSubsequentLaunchesAreInert() {
        _ = FreshInstallGuard.evaluate(defaults: defaults, databaseExists: false)
        seedProbeKeychainItem() // credentials written after onboarding

        let decision = FreshInstallGuard.evaluate(defaults: defaults, databaseExists: false)

        XCTAssertEqual(decision, .alreadyInitialized)
        XCTAssertTrue(probeKeychainItemExists(), "post-onboarding credentials must survive")
    }

    /// The full lifecycle the bug report describes: install → onboard →
    /// delete app (container gone: defaults cleared, DB gone; Keychain
    /// survives) → reinstall. The second install must start clean.
    func testReinstallDoesNotInheritCredentials() {
        // First install onboards and stores credentials.
        _ = FreshInstallGuard.evaluate(defaults: defaults, databaseExists: false)
        seedProbeKeychainItem()
        XCTAssertEqual(
            FreshInstallGuard.evaluate(defaults: defaults, databaseExists: true),
            .alreadyInitialized
        )

        // App deleted: container-scoped state dies, Keychain does not.
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
        let reinstallDefaults = UserDefaults(suiteName: suiteName)!
        XCTAssertTrue(probeKeychainItemExists(), "Keychain survives app deletion on iOS")

        let decision = FreshInstallGuard.evaluate(
            defaults: reinstallDefaults,
            databaseExists: false
        )

        XCTAssertEqual(decision, .purgedFreshInstall)
        XCTAssertFalse(probeKeychainItemExists(), "reinstall must not inherit credentials")
    }
}
