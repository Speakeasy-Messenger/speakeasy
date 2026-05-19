//
//  SecureKvModule.swift
//  Speakeasy
//
//  RN bridge for an encrypted key-value store, backed by the `kv` table
//  in the SQLCipher SpeakeasyDb. Mirrors
//  apps/mobile/android/.../db/SecureKvModule.kt — same JS bridge name
//  (`SecureKv`), same get/set/delete shape.
//
//  Why it exists: decrypted conversation history used to be persisted
//  to AsyncStorage (an unencrypted store). The Signal keys already live
//  in the SQLCipher DB; the decrypted message bodies belong in the same
//  encrypted store. `store/conversations.ts` persists through this.
//
//  The DB only opens once enrollment has placed a Vouchflow device
//  token (its passphrase is HKDF-derived from that token). Calls before
//  enrollment throw `.notEnrolled`; the JS layer treats a rejection as
//  "nothing persisted" and falls back to in-memory state.
//
//  Values cross the bridge as UTF-8 strings (the caller persists JSON)
//  and are stored as BLOB.
//
//  sqlite3 C symbols arrive via the bridging header (#import <sqlite3.h>).
//

import Foundation

@objc(SecureKvModule)
final class SecureKvModule: NSObject {

    @objc static func requiresMainQueueSetup() -> Bool { false }

    // SQLite copies the bound buffer immediately — safe with Swift's
    // short-lived String/Data bridges. Mirrors SqlCipherSignalProtocolStore.
    private static let transient =
        unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    @objc(get:resolver:rejecter:)
    func get(_ key: String,
             resolver resolve: @escaping RCTPromiseResolveBlock,
             rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let db = try SpeakeasyDb.shared.open()
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(
                db, "SELECT value FROM kv WHERE key = ?;", -1, &stmt, nil
            ) == SQLITE_OK else {
                throw SpeakeasyDbError.open(String(cString: sqlite3_errmsg(db)))
            }
            sqlite3_bind_text(stmt, 1, key, -1, SecureKvModule.transient)
            if sqlite3_step(stmt) == SQLITE_ROW {
                let len = sqlite3_column_bytes(stmt, 0)
                if let ptr = sqlite3_column_blob(stmt, 0), len > 0 {
                    let data = Data(bytes: ptr, count: Int(len))
                    resolve(String(data: data, encoding: .utf8))
                } else {
                    resolve("")
                }
            } else {
                resolve(nil)
            }
        } catch {
            reject("secure_kv_get_failed", "\(error)", error)
        }
    }

    @objc(set:value:resolver:rejecter:)
    func set(_ key: String, value: String,
             resolver resolve: @escaping RCTPromiseResolveBlock,
             rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let db = try SpeakeasyDb.shared.open()
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(
                db, "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?);",
                -1, &stmt, nil
            ) == SQLITE_OK else {
                throw SpeakeasyDbError.open(String(cString: sqlite3_errmsg(db)))
            }
            sqlite3_bind_text(stmt, 1, key, -1, SecureKvModule.transient)
            let blob = Data(value.utf8)
            blob.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                sqlite3_bind_blob(stmt, 2, buf.baseAddress,
                                  Int32(buf.count), SecureKvModule.transient)
            }
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                throw SpeakeasyDbError.open(String(cString: sqlite3_errmsg(db)))
            }
            resolve(nil)
        } catch {
            reject("secure_kv_set_failed", "\(error)", error)
        }
    }

    @objc(delete:resolver:rejecter:)
    func delete(_ key: String,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let db = try SpeakeasyDb.shared.open()
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(
                db, "DELETE FROM kv WHERE key = ?;", -1, &stmt, nil
            ) == SQLITE_OK else {
                throw SpeakeasyDbError.open(String(cString: sqlite3_errmsg(db)))
            }
            sqlite3_bind_text(stmt, 1, key, -1, SecureKvModule.transient)
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                throw SpeakeasyDbError.open(String(cString: sqlite3_errmsg(db)))
            }
            resolve(nil)
        } catch {
            reject("secure_kv_delete_failed", "\(error)", error)
        }
    }
}
