//
//  DbKeyStore.swift
//  Speakeasy
//
//  Stable secret that seeds the SpeakeasyDb SQLCipher passphrase.
//  Mirrors apps/mobile/android/.../db/DbKeyStore.kt.
//
//  # Why this exists
//
//  The DB passphrase used to be HKDF-derived directly from the Vouchflow
//  device token. That token is an attestation credential — it rotates on
//  biometric reconfiguration and reinstall. Tying the data-at-rest key to
//  it meant any such event silently re-keyed the database, SQLCipher then
//  rejected the old file ("file is not a database"), and the user lost
//  every conversation with no recovery path.
//
//  # What this does instead
//
//  The passphrase is derived from a db root secret generated once and
//  frozen for the life of the install. The secret lives in the Keychain
//  as a generic-password item:
//
//    - kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: readable after
//      the first unlock following a reboot, device-bound, never synced to
//      iCloud. It is NOT biometric-bound, so Face/Touch ID re-enrollment
//      does not invalidate it — the whole point of the decoupling.
//    - The item is app-scoped: it does not survive uninstall, which is
//      the intended policy (reinstall = fresh start).
//

import Foundation
import Security

enum DbKeyStore {
    private static let service = "xyz.speakeasyapp.db"
    private static let account = "root-secret-v1"

    /// Outcome of a root-secret read. The distinction is load-bearing: a
    /// missing item (`absent`) is the safe "fresh install" path where seeding
    /// a new secret is correct, but a *failed read* (`unavailable`) means the
    /// secret may well still exist — re-keying then would WIPE all Signal
    /// sessions + message history for what is often a transient error (device
    /// locked right after a reboot/OS-update → errSecInteractionNotAllowed
    /// -25308; missing keychain entitlement → -34018). The caller MUST NOT
    /// wipe on `unavailable`. Collapsing these two into "nil" was the cause of
    /// "all my messages disappeared after an update" + "couldn't decrypt this
    /// message" (the session the secret protected got wiped).
    enum LoadResult {
        case found(String)
        case absent
        case unavailable(OSStatus)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// Read the db root secret, distinguishing "no item" from "read failed".
    static func loadResult() -> LoadResult {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let s = String(data: data, encoding: .utf8) else {
                // Item present but unreadable/garbled — treat as a read
                // failure, NOT as absent. Never wipe on this.
                NSLog("[DbKeyStore] item present but undecodable — treating as unavailable (will NOT wipe)")
                return .unavailable(errSecDecode)
            }
            return .found(s)
        case errSecItemNotFound:
            return .absent
        default:
            NSLog("[DbKeyStore] load failed: OSStatus \(status) — secret may exist; will NOT wipe, open will retry. (-25308 = device locked after reboot/OS update; -34018 = keychain entitlement missing on unsigned simulator builds)")
            return .unavailable(status)
        }
    }

    /// The persisted db root secret, or `nil` if absent **or unreadable**.
    /// Prefer `loadResult()` on the open path so a transient read failure
    /// isn't mistaken for "fresh install" and used to justify a wipe.
    static func load() -> String? {
        if case .found(let s) = loadResult() { return s }
        return nil
    }

    /// Persist `secret` as the db root secret. Overwrites any prior value.
    /// Returns `true` iff the secret is now durably stored (verified by a
    /// read-back); a `false` return means the next launch will re-key and
    /// wipe — the caller logs the loss path.
    @discardableResult
    static func store(_ secret: String) -> Bool {
        SecItemDelete(baseQuery() as CFDictionary)
        var add = baseQuery()
        add[kSecValueData as String] = Data(secret.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            NSLog("[DbKeyStore] store failed: OSStatus \(status) — db root secret NOT persisted; history will reset every launch until this succeeds. (-34018 = keychain entitlement missing, common on unsigned simulator builds)")
            return false
        }
        // Read-back guard: confirm the write is actually retrievable. Catches
        // platforms/configs where SecItemAdd reports success but the item is
        // not readable on the next access path.
        if load() == nil {
            NSLog("[DbKeyStore] store succeeded but read-back returned nil — keychain not persisting; history will reset every launch")
            return false
        }
        return true
    }

    /// Drop the stored secret. Used by account deletion alongside
    /// `SpeakeasyDb.wipe()` so a re-enrollment starts from an empty store.
    static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}
