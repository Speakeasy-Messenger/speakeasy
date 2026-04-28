//
//  SpeakeasyDb.swift
//  Speakeasy
//
//  Phase 5c iOS — SQLCipher-backed local DB. Mirrors
//  apps/mobile/android/.../db/SpeakeasyDb.kt
//
//  # Key derivation (spec §4c)
//
//  Same as Android: HKDF-SHA256(Vouchflow.shared.cachedDeviceToken,
//  salt="speakeasy-db-v1", info="sqlcipher-passphrase", L=32).
//  cachedDeviceToken is bytewise-stable across cold starts (Vouchflow
//  iOS SDK ≥ 1.0.3 — Keychain-backed, mirrors AccountManager on Android).
//
//  # Bootstrap invariant
//
//  open() throws NotEnrolled if the cached token is null. The JS layer
//  drives `vouchflow.verify({context: 'signup'})` first; that call
//  populates the Keychain entry which subsequent SDK calls (and our
//  passphrase derivation) read.
//
//  # CryptoKit HKDF
//
//  Apple ships HKDF<HashFunction> in CryptoKit (iOS 14+). We use the
//  SymmetricKey-typed extract+expand path; output is 32 raw bytes the
//  C `sqlite3_key` API expects.
//

import Foundation
import CryptoKit
import VouchflowSDK
// SQLCipher (the C library) ships sqlite3.h via CocoaPods but does not
// expose a Swift module. The C symbols (sqlite3_open, sqlite3_key, …)
// are made visible via the bridging header (#import <sqlite3.h>).

enum SpeakeasyDbError: Error, CustomStringConvertible {
    case notEnrolled
    case open(String)
    case key(String)
    case migration(String)

    var description: String {
        switch self {
        case .notEnrolled:        return "SpeakeasyDb cannot open: Vouchflow.shared.cachedDeviceToken is nil. Run vouchflow.verify({context:'signup'}) before any Signal-store call."
        case .open(let m):        return "SpeakeasyDb open failed: \(m)"
        case .key(let m):         return "SpeakeasyDb key failed: \(m)"
        case .migration(let m):   return "SpeakeasyDb migration failed: \(m)"
        }
    }
}

final class SpeakeasyDb {

    private static let DB_FILENAME = "speakeasy.db"
    private static let HKDF_SALT = Data("speakeasy-db-v1".utf8)
    private static let HKDF_INFO = Data("sqlcipher-passphrase".utf8)
    private static let PASSPHRASE_BYTES = 32

    static let shared = SpeakeasyDb()
    private init() {}

    private let lock = NSLock()
    private(set) var handle: OpaquePointer?

    /// Idempotent. First call opens + migrates; subsequent calls are no-ops.
    /// Throws `.notEnrolled` if the deviceToken isn't in Keychain yet.
    func open() throws -> OpaquePointer {
        lock.lock()
        defer { lock.unlock() }
        if let h = handle { return h }

        guard let token = Vouchflow.shared.cachedDeviceToken else {
            throw SpeakeasyDbError.notEnrolled
        }
        let passphrase = derivePassphrase(deviceToken: token)
        let dbPath = try databasePath()

        var db: OpaquePointer?
        let openRc = sqlite3_open(dbPath, &db)
        if openRc != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            sqlite3_close(db)
            throw SpeakeasyDbError.open("sqlite3_open rc=\(openRc): \(msg)")
        }
        // Apply the SQLCipher key. Must happen BEFORE any other SQL
        // operation; otherwise SQLCipher refuses with "file is not a
        // database".
        let keyRc = passphrase.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Int32 in
            return sqlite3_key(db, buf.baseAddress, Int32(buf.count))
        }
        if keyRc != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            sqlite3_close(db)
            throw SpeakeasyDbError.key("sqlite3_key rc=\(keyRc): \(msg)")
        }
        // Cheap canary query. If the key is wrong this fails.
        if sqlite3_exec(db, "SELECT count(*) FROM sqlite_master;", nil, nil, nil) != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            sqlite3_close(db)
            throw SpeakeasyDbError.key("post-key canary failed: \(msg)")
        }

        try Schema.applyMigrations(db: db!)
        handle = db
        return db!
    }

    /// Test-only: close the in-process handle so the next open() reopens fresh.
    func closeForTest() {
        lock.lock()
        defer { lock.unlock() }
        if let h = handle {
            sqlite3_close(h)
            handle = nil
        }
    }

    private func databasePath() throws -> String {
        let docs = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return docs.appendingPathComponent(SpeakeasyDb.DB_FILENAME).path
    }

    /// HKDF-SHA256(token, salt, info, L=32). Returns the raw 32-byte key
    /// the C `sqlite3_key` API expects.
    private func derivePassphrase(deviceToken: String) -> Data {
        let ikm = SymmetricKey(data: Data(deviceToken.utf8))
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: SpeakeasyDb.HKDF_SALT,
            info: SpeakeasyDb.HKDF_INFO,
            outputByteCount: SpeakeasyDb.PASSPHRASE_BYTES
        )
        return key.withUnsafeBytes { Data(Array($0)) }
    }
}
