//
//  SpeakeasyDb.swift
//  Speakeasy
//
//  Phase 5c iOS — SQLCipher-backed local DB. Mirrors
//  apps/mobile/android/.../db/SpeakeasyDb.kt
//
//  # Key derivation (spec §4c)
//
//  HKDF-SHA256(db root secret, salt="speakeasy-db-v1",
//  info="sqlcipher-passphrase", L=32).
//
//  The root secret is generated once and frozen for the life of the
//  install — see DbKeyStore. It is NOT the Vouchflow device token.
//  Earlier builds derived the passphrase straight from the token, which
//  rotates on biometric reconfiguration and reinstall and silently
//  orphaned the database. Decoupling the at-rest key from the
//  attestation credential fixes that.
//
//  # Bootstrap invariant
//
//  open() throws .notEnrolled when there is no device token — not
//  because the key needs it, but because an un-enrolled app has no
//  identity to store. The JS layer drives `vouchflow.verify` first.
//
//  # Recovery
//
//  If the file on disk can't be decrypted with the current passphrase
//  (orphaned by the old token-derived scheme, or corrupt), open() logs
//  it, deletes the file, and recreates an empty store so the app stays
//  usable. Lost contents are unrecoverable.
//
//  # CryptoKit HKDF
//
//  Apple ships HKDF<HashFunction> in CryptoKit (iOS 14+). Output is 32
//  raw bytes the C `sqlite3_key` API expects.
//

import Foundation
import CryptoKit
import Security
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
    private static let ROOT_SECRET_BYTES = 32

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

        // The token gates "is the app enrolled at all" — it no longer
        // keys the database. See file header.
        guard let token = Vouchflow.shared.cachedDeviceToken else {
            throw SpeakeasyDbError.notEnrolled
        }
        let dbPath = try databasePath()
        let secret = resolveRootSecret(dbPath: dbPath, deviceToken: token)
        let passphrase = derivePassphrase(rootSecret: secret)

        let db = try openOrRecover(dbPath: dbPath, passphrase: passphrase)
        try Schema.applyMigrations(db: db)
        handle = db
        return db
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

    /// Permanently delete the encrypted DB and its db root secret. Used
    /// by account deletion so a re-enrollment starts from an empty store.
    func wipe() {
        lock.lock()
        defer { lock.unlock() }
        if let h = handle {
            sqlite3_close(h)
            handle = nil
        }
        if let path = try? databasePath() {
            deleteDbFiles(dbPath: path)
        }
        DbKeyStore.clear()
    }

    /// Resolve the db root secret, seeding DbKeyStore on first use.
    ///
    /// If a legacy DB file already exists it was keyed by HKDF(token);
    /// seed with the token so the derivation output is unchanged and the
    /// user's history opens. A fresh install seeds with a random secret.
    private func resolveRootSecret(dbPath: String, deviceToken: String) -> String {
        if let existing = DbKeyStore.load() { return existing }
        let seed = FileManager.default.fileExists(atPath: dbPath)
            ? deviceToken
            : randomSecret()
        DbKeyStore.store(seed)
        return seed
    }

    /// Open the database, recreating it empty if the file cannot be
    /// decrypted with `passphrase`. Only a key failure triggers the
    /// recreate — a genuine open failure (filesystem) is rethrown.
    private func openOrRecover(dbPath: String, passphrase: Data) throws -> OpaquePointer {
        do {
            return try openKeyed(dbPath: dbPath, passphrase: passphrase)
        } catch SpeakeasyDbError.key(let msg) {
            NSLog("[SpeakeasyDb] speakeasy.db unreadable (\(msg)) — recreating empty store")
            deleteDbFiles(dbPath: dbPath)
            return try openKeyed(dbPath: dbPath, passphrase: passphrase)
        }
    }

    /// `sqlite3_open` + `sqlite3_key` + a canary read. Throws `.key` when
    /// the passphrase doesn't match the file, `.open` on a real open error.
    private func openKeyed(dbPath: String, passphrase: Data) throws -> OpaquePointer {
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
        // Cheap canary query. If the key is wrong this fails — SQLCipher
        // verifies the passphrase lazily, on the first read.
        if sqlite3_exec(db, "SELECT count(*) FROM sqlite_master;", nil, nil, nil) != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            sqlite3_close(db)
            throw SpeakeasyDbError.key("post-key canary failed: \(msg)")
        }
        return db!
    }

    /// Delete the DB file and its `-journal` / `-wal` / `-shm` sidecars.
    private func deleteDbFiles(dbPath: String) {
        let fm = FileManager.default
        for suffix in ["", "-journal", "-wal", "-shm"] {
            try? fm.removeItem(atPath: dbPath + suffix)
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

    /// A fresh 32-byte random secret, Base64-encoded.
    private func randomSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: SpeakeasyDb.ROOT_SECRET_BYTES)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
    }

    /// HKDF-SHA256(rootSecret, salt, info, L=32). Returns the raw 32-byte
    /// key the C `sqlite3_key` API expects.
    private func derivePassphrase(rootSecret: String) -> Data {
        let ikm = SymmetricKey(data: Data(rootSecret.utf8))
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: SpeakeasyDb.HKDF_SALT,
            info: SpeakeasyDb.HKDF_INFO,
            outputByteCount: SpeakeasyDb.PASSPHRASE_BYTES
        )
        return key.withUnsafeBytes { Data(Array($0)) }
    }
}
