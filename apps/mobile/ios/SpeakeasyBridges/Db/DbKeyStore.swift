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

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// The persisted db root secret, or `nil` if none has been seeded yet.
    static func load() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            // errSecItemNotFound is the normal "fresh install" path. ANY other
            // status (notably errSecMissingEntitlement -34018, which sim builds
            // without a provisioned keychain-access-group hit) means the read
            // failed — the caller will then re-key and WIPE the encrypted store,
            // losing all Signal sessions + message history. Never let that be
            // silent; it's the root cause of "couldn't decrypt this message"
            // after a relaunch (the session the secret protected is gone).
            if status != errSecItemNotFound {
                NSLog("[DbKeyStore] load failed: OSStatus \(status) — store will re-key & WIPE; sessions/history lost. (-34018 = keychain entitlement missing, common on unsigned simulator builds)")
            }
            return nil
        }
        return String(data: data, encoding: .utf8)
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
