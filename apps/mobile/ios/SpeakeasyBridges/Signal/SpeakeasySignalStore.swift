//
//  SpeakeasySignalStore.swift
//  Speakeasy
//
//  Singleton holder for the active SignalProtocol store. Mirrors
//  apps/mobile/android/.../signal/SpeakeasySignalStore.kt
//
//  Phase 5c: SQLCipher-backed by default. On first init the store is
//  reconstructed from disk (`loadFromDb`); on a fresh install the
//  caller passes a freshly generated identity to `initialize` which
//  writes it to the encrypted DB.
//

import Foundation
import LibSignalClient

enum SpeakeasySignalStore {
    private static let lock = NSLock()
    private static var instance: SqlCipherSignalProtocolStore?

    /// Restore from disk if a previous identity exists. Returns false ONLY
    /// when the store is genuinely absent — no identity row yet (fresh
    /// install), or the DB can't open because Vouchflow.cachedDeviceToken
    /// is nil (not enrolled). Any OTHER failure THROWS.
    ///
    /// The distinction is load-bearing: `generateIdentityKey` mints a
    /// fresh identity on `false`. The previous version returned false for
    /// unexpected DB failures too (transient keychain unavailability,
    /// SQLCipher open errors during an update relaunch), which silently
    /// REPLACED the user's identity while they kept their handle — every
    /// peer then saw "[identity changed — verify with peer]" and calls
    /// died on UntrustedIdentityException, with no reinstall having
    /// happened. Android's initializeFromDb has always propagated
    /// unexpected errors; this brings iOS to parity.
    static func initializeFromDb() throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        do {
            let db = try SpeakeasyDb.shared.open()
            guard let store = try SqlCipherSignalProtocolStore.loadFromDb(db) else {
                return false
            }
            instance = store
            return true
        } catch SpeakeasyDbError.notEnrolled {
            return false
        }
        // Unexpected DB failure propagates — callers must NOT treat it
        // as "no identity yet".
    }

    /// Initialise from a freshly generated identity. Persists to the DB.
    static func initialize(identityKeyPair: IdentityKeyPair, registrationId: UInt32) throws {
        lock.lock()
        defer { lock.unlock() }
        let db = try SpeakeasyDb.shared.open()
        let store = SqlCipherSignalProtocolStore(
            db: db,
            identityKeyPair: identityKeyPair,
            registrationId: registrationId
        )
        try store.persistLocalIdentity()
        instance = store
    }

    static var isInitialized: Bool {
        lock.lock(); defer { lock.unlock() }
        return instance != nil
    }

    static func require() throws -> SqlCipherSignalProtocolStore {
        lock.lock(); defer { lock.unlock() }
        guard let i = instance else {
            throw NSError(domain: "SpeakeasySignalStore", code: -1,
                          userInfo: [NSLocalizedDescriptionKey:
                                        "SpeakeasySignalStore not initialized — call generateIdentityKey first"])
        }
        return i
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        instance = nil
    }
}
