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
//  rotates on biometric reconfiguration and Vouchflow re-attestation
//  and silently orphaned the database. Decoupling the at-rest key from
//  the attestation credential fixes that.
//
//  # Bootstrap invariant
//
//  open() throws .notEnrolled when there is no device token — not
//  because the key needs it, but because an un-enrolled app has no
//  identity to store. The JS layer drives `vouchflow.verify` first.
//
//  # First-launch wipe (intentional)
//
//  The first launch with no DbKeyStore secret always seeds a fresh
//  random secret. If a database file already exists on disk it was
//  created by an older build (token-derived scheme) and we can't
//  safely guess the key it was made with — the token may have rotated
//  since enrollment. Earlier code tried to seed the secret with the
//  current device token to preserve history through the migration,
//  but that silently lost data the moment the token had moved, with
//  no signal to the user. The honest move is to wipe the orphan
//  deterministically and surface the reset to JS via consumeResetFlag.
//
//  # Recovery
//
//  If the file on disk can't be decrypted with the current passphrase
//  (genuine corruption, lost Keychain item), open() logs it, deletes
//  the file, sets the reset flag, and recreates an empty store so the
//  app stays usable. Lost contents are unrecoverable.
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

    /// UserDefaults key for the one-shot "the local store was reset"
    /// flag. UI hint only, never a secret.
    private static let RESET_FLAG_KEY = "xyz.speakeasyapp.db.storeWasReset"

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

    /// Read-and-clear the "your local store was reset" flag. JS calls
    /// this once at startup and surfaces a banner / diag entry when it
    /// returns true. Returns false on a fresh install and on every
    /// normal launch.
    func consumeResetFlag() -> Bool {
        let ud = UserDefaults.standard
        let wasSet = ud.bool(forKey: SpeakeasyDb.RESET_FLAG_KEY)
        if wasSet { ud.removeObject(forKey: SpeakeasyDb.RESET_FLAG_KEY) }
        return wasSet
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
    ///
    /// Does NOT set the reset flag — this path is user-initiated; the UI
    /// already shows its own confirmation. The flag is for *unexpected*
    /// resets only.
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
    /// On a fresh install no DB file exists — seed with a random secret,
    /// create an empty DB on first open, done. On the first launch after
    /// upgrading from the old token-derived scheme a file exists but its
    /// key is whatever token was current at enrollment, and we have no
    /// reliable way to reproduce it (the token may have rotated). The
    /// deterministic move is to wipe the orphan, seed fresh, and set the
    /// reset flag so JS can surface the loss to the user.
    private func resolveRootSecret(dbPath: String, deviceToken: String) -> String {
        if let existing = DbKeyStore.load() { return existing }
        if FileManager.default.fileExists(atPath: dbPath) {
            NSLog("[SpeakeasyDb] first launch with no db root secret + existing speakeasy.db — wiping orphan and starting fresh")
            deleteDbFiles(dbPath: dbPath)
            setResetFlag()
        }
        let seed = randomSecret()
        DbKeyStore.store(seed)
        return seed
    }

    /// Open the database, recreating it empty if the file cannot be
    /// decrypted with `passphrase`. Hits only on genuine corruption /
    /// lost Keychain item after the install — the upgrade case is
    /// already handled in resolveRootSecret. Only a key failure
    /// triggers the recreate; a genuine open failure (filesystem) is
    /// rethrown.
    private func openOrRecover(dbPath: String, passphrase: Data) throws -> OpaquePointer {
        do {
            return try openKeyed(dbPath: dbPath, passphrase: passphrase)
        } catch SpeakeasyDbError.key(let msg) {
            NSLog("[SpeakeasyDb] speakeasy.db unreadable (\(msg)) — recreating empty store")
            deleteDbFiles(dbPath: dbPath)
            setResetFlag()
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

    /// Mark "the local store was reset" so JS can surface it next launch.
    private func setResetFlag() {
        UserDefaults.standard.set(true, forKey: SpeakeasyDb.RESET_FLAG_KEY)
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
