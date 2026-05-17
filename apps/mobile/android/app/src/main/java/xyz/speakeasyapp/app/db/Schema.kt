package xyz.speakeasyapp.app.db

import net.zetetic.database.sqlcipher.SQLiteDatabase

/**
 * On-disk schema migrations for the encrypted local DB.
 *
 * Migration model: each version's DDL lives in [MIGRATIONS] as one or more
 * statements. We compare against `PRAGMA user_version` and apply forward
 * in order. No down-migrations — recovery from a bad upgrade is the
 * out-of-band re-enrollment flow (which destroys the DB anyway).
 *
 * # Tables (Phase 5c)
 *
 * - **identity**: singleton (`id = 0`) row holding `IdentityKeyPair` +
 *   `registrationId`. Recreated on re-enrollment.
 * - **prekeys**: one-time prekey records. Identified by integer id (matches
 *   libsignal's `PreKeyStore` API).
 * - **signed_prekeys**: signed prekey records. Same shape, different
 *   rotation cadence.
 * - **sessions**: `(name, device_id) → session_record_bytes`. The libsignal
 *   `SessionStore` API keys on a `SignalProtocolAddress`, which is exactly
 *   `(name: String, deviceId: Int)`.
 * - **identities**: trusted peer identity keys, keyed on
 *   `(name, device_id)`. Used by `IdentityKeyStore.saveIdentity` and
 *   `isTrustedIdentity` (TOFU model).
 * - **sender_keys** (v2): libsignal SenderKey records for group
 *   messaging, keyed on `(name, device_id, distribution_id)`. The
 *   distribution UUID is libsignal's per-(sender, group) identifier;
 *   one sender holds N records (one per group they participate in),
 *   and one recipient holds M records (one per (sender, group) pair
 *   they've received an SKDM for).
 * - **decrypt_cache** (v3): plaintext keyed by `SHA-256(ciphertext)`.
 *   Makes decryption idempotent — see `signal/DecryptCache.kt` for why
 *   (the headless push handler and the in-app WS path both decrypt the
 *   same message; the ratchet may only advance once).
 */
object Schema {
  private val MIGRATIONS: List<List<String>> =
      listOf(
          // version 1 (Phase 5c initial)
          listOf(
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
              """,
          ),
          // version 2 (Sender Keys for group messaging)
          listOf(
              """
              CREATE TABLE sender_keys (
                name TEXT NOT NULL,
                device_id INTEGER NOT NULL,
                distribution_id TEXT NOT NULL,
                record BLOB NOT NULL,
                PRIMARY KEY (name, device_id, distribution_id)
              )
              """,
          ),
          // version 3 (idempotent-decrypt plaintext cache)
          listOf(
              """
              CREATE TABLE decrypt_cache (
                ct_hash TEXT PRIMARY KEY,
                plaintext BLOB NOT NULL,
                created_at INTEGER NOT NULL
              )
              """,
          ),
      )

  fun applyMigrations(db: SQLiteDatabase) {
    // Don't use rawQuery for PRAGMA reads: SQLCipher Android's
    // rawQuery(String, Object...) overload mis-binds empty Object[]
    // arrays against PRAGMA's 0-parameter prepared statements,
    // throwing "cannot bind argument at index 1 because the index is
    // out of range. The statement has 0 parameters." compileStatement
    // → simpleQueryForLong is the canonical path.
    val current = db.compileStatement("PRAGMA user_version").use {
      it.simpleQueryForLong().toInt()
    }
    if (current >= MIGRATIONS.size) return
    db.beginTransaction()
    try {
      for (i in current until MIGRATIONS.size) {
        for (stmt in MIGRATIONS[i]) {
          db.execSQL(stmt.trimIndent())
        }
      }
      db.execSQL("PRAGMA user_version = ${MIGRATIONS.size}")
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }
}
