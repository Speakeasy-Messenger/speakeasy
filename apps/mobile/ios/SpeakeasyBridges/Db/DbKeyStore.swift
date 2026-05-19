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
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Persist `secret` as the db root secret. Overwrites any prior value.
    static func store(_ secret: String) {
        SecItemDelete(baseQuery() as CFDictionary)
        var add = baseQuery()
        add[kSecValueData as String] = Data(secret.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    /// Drop the stored secret. Used by account deletion alongside
    /// `SpeakeasyDb.wipe()` so a re-enrollment starts from an empty store.
    static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}
