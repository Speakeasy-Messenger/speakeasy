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
      )

  fun applyMigrations(db: SQLiteDatabase) {
    val cur = db.rawQuery("PRAGMA user_version", arrayOf<Any?>())
    val current =
        if (cur.moveToFirst()) cur.getInt(0).also { cur.close() } else 0.also { cur.close() }
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
