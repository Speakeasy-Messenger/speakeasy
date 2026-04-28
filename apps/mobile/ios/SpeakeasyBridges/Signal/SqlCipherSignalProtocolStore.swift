//
//  SqlCipherSignalProtocolStore.swift
//  Speakeasy
//
//  SQLCipher-backed implementation of libsignal-client iOS's per-store
//  protocols. Mirrors apps/mobile/android/.../signal/SqlCipherSignalProtocolStore.kt
//  but matches the leaner iOS protocol surface (no `containsPreKey`,
//  `containsSession`, `getSubDeviceSessions`, etc. — those are Java-only).
//
//  iOS protocols implemented:
//    - IdentityKeyStore (identityKeyPair, localRegistrationId, save/is-trusted/identity)
//    - PreKeyStore     (loadPreKey, storePreKey, removePreKey)
//    - SignedPreKeyStore (loadSignedPreKey, storeSignedPreKey)
//    - SessionStore    (loadSession[opt], loadExistingSessions, storeSession)
//    - SenderKeyStore  (storeSenderKey, loadSenderKey)
//    - KyberPreKeyStore (loadKyberPreKey, storeKyberPreKey, markKyberPreKeyUsed)
//      — Kyber kept in an in-memory Dict; not persisted because Phase 5b
//      doesn't exercise post-quantum key agreement yet.
//

import Foundation
import LibSignalClient
// sqlite3 C symbols come in via the bridging header (#import <sqlite3.h>).

final class SqlCipherSignalProtocolStore:
    IdentityKeyStore,
    PreKeyStore,
    SignedPreKeyStore,
    SessionStore,
    SenderKeyStore,
    KyberPreKeyStore
{
    let db: OpaquePointer
    private let identityKeyPairData: [UInt8]
    private let registrationIdValue: UInt32

    /// Phase 5b: Kyber pre-keys are not yet exercised. Held in-memory so
    /// the protocol contract is satisfied; persistence lands when post-
    /// quantum is wired (Phase 5b carry-over).
    private var kyberStore: [UInt32: [UInt8]] = [:]

    init(db: OpaquePointer, identityKeyPair: IdentityKeyPair, registrationId: UInt32) {
        self.db = db
        self.identityKeyPairData = identityKeyPair.serialize()
        self.registrationIdValue = registrationId
    }

    // MARK: - IdentityKeyStore

    func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair {
        return try IdentityKeyPair(bytes: identityKeyPairData)
    }

    func localRegistrationId(context: StoreContext) throws -> UInt32 {
        return registrationIdValue
    }

    func saveIdentity(_ identity: IdentityKey,
                      for address: ProtocolAddress,
                      context: StoreContext) throws -> Bool {
        // `self.identity(for:)` — disambiguate from the `identity` parameter.
        let existing = try self.identity(for: address, context: context)
        let bytes = identity.serialize()
        try exec(
            "INSERT OR REPLACE INTO identities(name, device_id, identity_key) VALUES(?, ?, ?)",
            bind: [.text(address.name), .int(Int(address.deviceId)), .blob(Data(bytes))]
        )
        // Per libsignal contract: returns true when the identity row is
        // new or replaces a different key.
        guard let prev = existing else { return true }
        return prev.serialize() != bytes
    }

    func isTrustedIdentity(_ identity: IdentityKey,
                           for address: ProtocolAddress,
                           direction: Direction,
                           context: StoreContext) throws -> Bool {
        let stored = try self.identity(for: address, context: context)
        guard let stored = stored else { return true } // TOFU
        return stored.serialize() == identity.serialize()
    }

    func identity(for address: ProtocolAddress,
                  context: StoreContext) throws -> IdentityKey? {
        let row = try queryOne(
            "SELECT identity_key FROM identities WHERE name = ? AND device_id = ?",
            bind: [.text(address.name), .int(Int(address.deviceId))]
        )
        guard let blob = row?.first?.asBlob else { return nil }
        return try IdentityKey(bytes: Array(blob))
    }

    // MARK: - PreKeyStore

    func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
        let row = try queryOne(
            "SELECT record FROM prekeys WHERE id = ?",
            bind: [.int(Int(id))]
        )
        guard let blob = row?.first?.asBlob else {
            throw SignalError.invalidKeyIdentifier("no such prekey: \(id)")
        }
        return try PreKeyRecord(bytes: Array(blob))
    }

    func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws {
        try exec(
            "INSERT OR REPLACE INTO prekeys(id, record) VALUES(?, ?)",
            bind: [.int(Int(id)), .blob(Data(record.serialize()))]
        )
    }

    func removePreKey(id: UInt32, context: StoreContext) throws {
        try exec("DELETE FROM prekeys WHERE id = ?", bind: [.int(Int(id))])
    }

    // MARK: - SignedPreKeyStore

    func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
        let row = try queryOne(
            "SELECT record FROM signed_prekeys WHERE id = ?",
            bind: [.int(Int(id))]
        )
        guard let blob = row?.first?.asBlob else {
            throw SignalError.invalidKeyIdentifier("no such signed prekey: \(id)")
        }
        return try SignedPreKeyRecord(bytes: Array(blob))
    }

    func storeSignedPreKey(_ record: SignedPreKeyRecord,
                           id: UInt32,
                           context: StoreContext) throws {
        try exec(
            "INSERT OR REPLACE INTO signed_prekeys(id, record) VALUES(?, ?)",
            bind: [.int(Int(id)), .blob(Data(record.serialize()))]
        )
    }

    // MARK: - SessionStore

    /// iOS contract: returns nil when no session exists (vs. Android's
    /// "fresh empty SessionRecord" sentinel).
    func loadSession(for address: ProtocolAddress,
                     context: StoreContext) throws -> SessionRecord? {
        let row = try queryOne(
            "SELECT record FROM sessions WHERE name = ? AND device_id = ?",
            bind: [.text(address.name), .int(Int(address.deviceId))]
        )
        guard let blob = row?.first?.asBlob else { return nil }
        return try SessionRecord(bytes: Array(blob))
    }

    /// iOS contract: returns only the sessions that exist; missing ones
    /// are skipped (no NoSession throw, unlike Android).
    func loadExistingSessions(for addresses: [ProtocolAddress],
                              context: StoreContext) throws -> [SessionRecord] {
        var out: [SessionRecord] = []
        out.reserveCapacity(addresses.count)
        for addr in addresses {
            if let s = try loadSession(for: addr, context: context) {
                out.append(s)
            }
        }
        return out
    }

    func storeSession(_ record: SessionRecord,
                      for address: ProtocolAddress,
                      context: StoreContext) throws {
        try exec(
            "INSERT OR REPLACE INTO sessions(name, device_id, record) VALUES(?, ?, ?)",
            bind: [.text(address.name),
                   .int(Int(address.deviceId)),
                   .blob(Data(record.serialize()))]
        )
    }

    // MARK: - SenderKeyStore

    func storeSenderKey(from sender: ProtocolAddress,
                        distributionId: UUID,
                        record: SenderKeyRecord,
                        context: StoreContext) throws {
        try exec(
            "INSERT OR REPLACE INTO sender_keys(name, device_id, distribution_id, record) " +
            "VALUES(?, ?, ?, ?)",
            bind: [.text(sender.name),
                   .int(Int(sender.deviceId)),
                   .text(distributionId.uuidString),
                   .blob(Data(record.serialize()))]
        )
    }

    func loadSenderKey(from sender: ProtocolAddress,
                       distributionId: UUID,
                       context: StoreContext) throws -> SenderKeyRecord? {
        let row = try queryOne(
            "SELECT record FROM sender_keys WHERE name = ? AND device_id = ? AND distribution_id = ?",
            bind: [.text(sender.name),
                   .int(Int(sender.deviceId)),
                   .text(distributionId.uuidString)]
        )
        guard let blob = row?.first?.asBlob else { return nil }
        return try SenderKeyRecord(bytes: Array(blob))
    }

    // MARK: - KyberPreKeyStore (in-memory; not yet exercised)

    func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
        guard let bytes = kyberStore[id] else {
            throw SignalError.invalidKeyIdentifier("no such kyber prekey: \(id)")
        }
        return try KyberPreKeyRecord(bytes: bytes)
    }

    func storeKyberPreKey(_ record: KyberPreKeyRecord,
                          id: UInt32,
                          context: StoreContext) throws {
        kyberStore[id] = record.serialize()
    }

    func markKyberPreKeyUsed(id: UInt32, context: StoreContext) throws {
        // No-op for the in-memory placeholder. Real impl will track a
        // "used" set so reuse is detected when persistence lands.
    }

    // MARK: - Convenience: persist initial identity

    /// Write the local identity to the singleton row. Call once after a
    /// fresh enrollment so subsequent app starts can reconstruct the
    /// store via `loadFromDb`.
    func persistLocalIdentity() throws {
        try exec(
            "INSERT OR REPLACE INTO identity(id, identity_key_pair, registration_id) VALUES(0, ?, ?)",
            bind: [.blob(Data(identityKeyPairData)), .int(Int(registrationIdValue))]
        )
    }

    static func loadFromDb(_ db: OpaquePointer) throws -> SqlCipherSignalProtocolStore? {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db,
                                 "SELECT identity_key_pair, registration_id FROM identity WHERE id = 0",
                                 -1, &stmt, nil) == SQLITE_OK,
              sqlite3_step(stmt) == SQLITE_ROW
        else { return nil }
        let blobLen = sqlite3_column_bytes(stmt, 0)
        guard let blobPtr = sqlite3_column_blob(stmt, 0), blobLen > 0 else { return nil }
        let ikpData = Data(bytes: blobPtr, count: Int(blobLen))
        let regId = UInt32(sqlite3_column_int(stmt, 1))
        let ikp = try IdentityKeyPair(bytes: Array(ikpData))
        return SqlCipherSignalProtocolStore(db: db, identityKeyPair: ikp, registrationId: regId)
    }

    // MARK: - Tiny SQLite helpers

    private enum Bound {
        case text(String)
        case int(Int)
        case blob(Data)
    }

    private struct Cell { let asBlob: Data? }

    private func bindAll(_ stmt: OpaquePointer, _ bindings: [Bound]) {
        let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, b) in bindings.enumerated() {
            let idx = Int32(i + 1)
            switch b {
            case .text(let s):
                sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT)
            case .int(let v):
                sqlite3_bind_int64(stmt, idx, Int64(v))
            case .blob(let d):
                d.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                    sqlite3_bind_blob(stmt, idx, buf.baseAddress, Int32(buf.count), SQLITE_TRANSIENT)
                }
            }
        }
    }

    private func exec(_ sql: String, bind bindings: [Bound]) throws {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) != SQLITE_OK {
            throw SpeakeasyDbError.migration("prepare failed: \(String(cString: sqlite3_errmsg(db)))")
        }
        bindAll(stmt!, bindings)
        if sqlite3_step(stmt) != SQLITE_DONE {
            throw SpeakeasyDbError.migration("step failed: \(String(cString: sqlite3_errmsg(db)))")
        }
    }

    private func queryOne(_ sql: String, bind bindings: [Bound]) throws -> [Cell]? {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) != SQLITE_OK {
            throw SpeakeasyDbError.migration("prepare failed: \(String(cString: sqlite3_errmsg(db)))")
        }
        bindAll(stmt!, bindings)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        let count = Int(sqlite3_column_count(stmt))
        var cells: [Cell] = []
        cells.reserveCapacity(count)
        for i in 0..<count {
            let col = Int32(i)
            switch sqlite3_column_type(stmt, col) {
            case SQLITE_BLOB:
                let len = sqlite3_column_bytes(stmt, col)
                if let p = sqlite3_column_blob(stmt, col), len > 0 {
                    cells.append(Cell(asBlob: Data(bytes: p, count: Int(len))))
                } else {
                    cells.append(Cell(asBlob: Data()))
                }
            default:
                cells.append(Cell(asBlob: nil))
            }
        }
        return cells
    }
}
