//
//  Schema.swift
//  Speakeasy
//
//  On-disk schema migrations for the encrypted local DB. Mirrors
//  apps/mobile/android/.../db/Schema.kt — same tables, same column
//  shapes, so the JS layer's expectations stay platform-agnostic.
//
//  Migration model: each version's DDL lives in `MIGRATIONS` as one or
//  more statements. We compare against `PRAGMA user_version` and apply
//  forward in order. No down-migrations.
//

import Foundation
// sqlite3 C symbols come in via the bridging header (#import <sqlite3.h>).

enum Schema {

    /// Versioned migrations. Index 0 = upgrade to v1, index 1 = upgrade to v2, …
    private static let MIGRATIONS: [[String]] = [
        // version 1 (Phase 5c initial)
        [
            """
            CREATE TABLE identity (
              id INTEGER PRIMARY KEY CHECK (id = 0),
              identity_key_pair BLOB NOT NULL,
              registration_id INTEGER NOT NULL
            )
            """,
            """
            CREATE TABLE prekeys (
              id INTEGER PRIMARY KEY,
              record BLOB NOT NULL
            )
            """,
            """
            CREATE TABLE signed_prekeys (
              id INTEGER PRIMARY KEY,
              record BLOB NOT NULL
            )
            """,
            """
            CREATE TABLE sessions (
              name TEXT NOT NULL,
              device_id INTEGER NOT NULL,
              record BLOB NOT NULL,
              PRIMARY KEY (name, device_id)
            )
            """,
            """
            CREATE TABLE identities (
              name TEXT NOT NULL,
              device_id INTEGER NOT NULL,
              identity_key BLOB NOT NULL,
              PRIMARY KEY (name, device_id)
            )
            """
        ],
        // version 2 (Sender Keys for group messaging)
        [
            """
            CREATE TABLE sender_keys (
              name TEXT NOT NULL,
              device_id INTEGER NOT NULL,
              distribution_id TEXT NOT NULL,
              record BLOB NOT NULL,
              PRIMARY KEY (name, device_id, distribution_id)
            )
            """
        ],
        // version 3 (idempotent-decrypt plaintext cache) — mirrors
        // Schema.kt v3; the iOS schema had been a version behind.
        [
            """
            CREATE TABLE decrypt_cache (
              ct_hash TEXT PRIMARY KEY,
              plaintext BLOB NOT NULL,
              created_at INTEGER NOT NULL
            )
            """
        ],
        // version 4 (encrypted app key-value store) — holds the
        // decrypted conversation history that used to sit in plaintext
        // AsyncStorage. See Db/SecureKvModule.swift and
        // store/conversations.ts.
        [
            """
            CREATE TABLE kv (
              key TEXT PRIMARY KEY,
              value BLOB NOT NULL
            )
            """
        ]
    ]

    static func applyMigrations(db: OpaquePointer) throws {
        let current = readUserVersion(db: db)
        if current >= MIGRATIONS.count { return }

        if sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil) != SQLITE_OK {
            throw SpeakeasyDbError.migration("could not begin tx")
        }

        for i in current..<MIGRATIONS.count {
            for stmt in MIGRATIONS[i] {
                if sqlite3_exec(db, stmt, nil, nil, nil) != SQLITE_OK {
                    let msg = String(cString: sqlite3_errmsg(db))
                    sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                    throw SpeakeasyDbError.migration("migration v\(i + 1) failed: \(msg)\nstmt: \(stmt)")
                }
            }
        }

        let setVersion = "PRAGMA user_version = \(MIGRATIONS.count);"
        if sqlite3_exec(db, setVersion, nil, nil, nil) != SQLITE_OK {
            sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
            throw SpeakeasyDbError.migration("could not set user_version")
        }
        if sqlite3_exec(db, "COMMIT;", nil, nil, nil) != SQLITE_OK {
            throw SpeakeasyDbError.migration("could not commit migration tx")
        }
    }

    private static func readUserVersion(db: OpaquePointer) -> Int {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "PRAGMA user_version;", -1, &stmt, nil) == SQLITE_OK,
              sqlite3_step(stmt) == SQLITE_ROW
        else {
            return 0
        }
        return Int(sqlite3_column_int(stmt, 0))
    }
}
