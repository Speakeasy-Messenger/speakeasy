//
//  DecryptCache.swift
//  Speakeasy
//
//  Idempotent-decrypt plaintext cache. Swift port of the Android
//  `signal/DecryptCache.kt` — keep the two in sync.
//
//  # Why this exists
//
//  libsignal decryption advances the Double Ratchet and is single-use:
//  decrypting a ciphertext a second time throws `SignalError.duplicatedMessage`.
//  The same wire message can reach the decrypt path more than once:
//    - the in-app WebSocket relay re-presents a row after a dropped ack
//      (the server redelivers on reconnect — see ws/client.ts), and
//    - once the rich-push Notification Service Extension ships, the headless
//      push handler will decrypt the same message to render its preview while
//      it also drains over the WS.
//  Without a cache the second decrypt fails and the user sees a spurious
//  "[couldn't decrypt this message]" bubble (and the recovery UI nudges
//  toward the destructive resetPeer).
//
//  # What this does
//
//  The ratchet runs at most once per ciphertext: the first decrypt caches its
//  plaintext (keyed by `SHA-256(ciphertext)`) in the encrypted `decrypt_cache`
//  table (Schema.swift v3); every later decrypt of that ciphertext returns the
//  cached plaintext without touching the ratchet. The lookup → decrypt → store
//  sequence is serialized under a lock so two callers racing the same
//  ciphertext can't both advance the ratchet. Entries prune after 7 days (the
//  relay-buffer TTL — by then the message is delivered both ways and is no
//  longer re-decryptable).
//

import Foundation
import CryptoKit

enum DecryptCache {
    private static let ttlMs: Int64 = 7 * 24 * 60 * 60 * 1000
    private static let lock = NSLock()
    // sqlite3 wants SQLITE_TRANSIENT so it copies bound bytes; the symbol
    // isn't imported, so reconstruct it the same way the Signal store does.
    private static let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Return the plaintext for `ciphertext`: a cache hit if it was decrypted
    /// before, otherwise `ratchetDecrypt` is run, its result cached, and
    /// returned. `ratchetDecrypt` errors propagate unchanged, so a genuine
    /// first-decrypt failure (no session, corrupt frame, untrusted identity)
    /// still surfaces to the caller exactly as before.
    static func decryptCached(ciphertext: [UInt8],
                              ratchetDecrypt: () throws -> [UInt8]) throws -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        // Cross-process serialization with the Notification Service Extension:
        // the in-process NSLock above only covers THIS process, so without this
        // the app and the NSE could both miss the cache and both advance the
        // ratchet for the same ciphertext. No-op when there's no App-Group
        // container (single-process build → NSLock alone, unchanged behavior).
        let xlock = CrossProcessLock(url: AppGroup.decryptLockURL())
        xlock.lock()
        defer { xlock.unlock() }
        let db = try SpeakeasyDb.shared.open()
        let hash = sha256Hex(ciphertext)
        if let cached = lookup(db: db, hash: hash) { return cached }
        let plaintext = try ratchetDecrypt()
        store(db: db, hash: hash, plaintext: plaintext)
        return plaintext
    }

    private static func lookup(db: OpaquePointer, hash: String) -> [UInt8]? {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "SELECT plaintext FROM decrypt_cache WHERE ct_hash = ?", -1, &stmt, nil) == SQLITE_OK else {
            return nil
        }
        sqlite3_bind_text(stmt, 1, hash, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        let len = sqlite3_column_bytes(stmt, 0)
        guard let ptr = sqlite3_column_blob(stmt, 0), len > 0 else { return nil }
        return Array(UnsafeRawBufferPointer(start: ptr, count: Int(len)))
    }

    private static func store(db: OpaquePointer, hash: String, plaintext: [UInt8]) {
        var insert: OpaquePointer?
        if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO decrypt_cache (ct_hash, plaintext, created_at) VALUES (?, ?, ?)", -1, &insert, nil) == SQLITE_OK {
            sqlite3_bind_text(insert, 1, hash, -1, SQLITE_TRANSIENT)
            plaintext.withUnsafeBytes { buf in
                _ = sqlite3_bind_blob(insert, 2, buf.baseAddress, Int32(buf.count), SQLITE_TRANSIENT)
            }
            sqlite3_bind_int64(insert, 3, nowMs())
            _ = sqlite3_step(insert)
        }
        sqlite3_finalize(insert)

        var prune: OpaquePointer?
        if sqlite3_prepare_v2(db, "DELETE FROM decrypt_cache WHERE created_at < ?", -1, &prune, nil) == SQLITE_OK {
            sqlite3_bind_int64(prune, 1, nowMs() - ttlMs)
            _ = sqlite3_step(prune)
        }
        sqlite3_finalize(prune)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    private static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
    }
}
