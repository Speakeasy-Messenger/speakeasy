package xyz.speakeasyapp.app.signal

import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.security.MessageDigest

/**
 * Idempotent-decrypt plaintext cache.
 *
 * libsignal decryption advances the Double Ratchet and is single-use:
 * decrypting a ciphertext a second time throws `DuplicateMessageException`.
 * The push-notification path needs to decrypt a message in the headless
 * FCM background handler to render its text, but the same message also
 * drains over the WebSocket relay and is decrypted again in-app. To let
 * both callers decrypt freely, the ratchet runs at most once per
 * ciphertext: the first decrypt caches its plaintext (keyed by
 * `SHA-256(ciphertext)`) in the encrypted `decrypt_cache` table, and
 * every later decrypt of that ciphertext returns the cached plaintext
 * without touching the ratchet.
 *
 * The lookup → decrypt → store sequence is serialized so two callers
 * racing the same ciphertext can't both advance the ratchet.
 *
 * Entries are pruned after 7 days (the relay-buffer TTL) — by then the
 * message has been delivered both ways and is no longer re-decryptable.
 */
object DecryptCache {
  private const val TTL_MS = 7L * 24 * 60 * 60 * 1000
  private val lock = Any()

  /**
   * Return the plaintext for [ciphertext]: a cache hit if it was decrypted
   * before, otherwise [ratchetDecrypt] is run, its result cached, and
   * returned. [ratchetDecrypt] exceptions propagate unchanged.
   */
  fun decryptCached(
      db: SQLiteDatabase,
      ciphertext: ByteArray,
      ratchetDecrypt: () -> ByteArray,
  ): ByteArray {
    synchronized(lock) {
      val hash = sha256Hex(ciphertext)
      lookup(db, hash)?.let {
        return it
      }
      val plaintext = ratchetDecrypt()
      store(db, hash, plaintext)
      return plaintext
    }
  }

  private fun lookup(db: SQLiteDatabase, hash: String): ByteArray? {
    db.rawQuery("SELECT plaintext FROM decrypt_cache WHERE ct_hash = ?", arrayOf(hash)).use {
      c ->
      if (c.moveToFirst()) return c.getBlob(0)
    }
    return null
  }

  private fun store(db: SQLiteDatabase, hash: String, plaintext: ByteArray) {
    db.compileStatement(
            "INSERT OR REPLACE INTO decrypt_cache (ct_hash, plaintext, created_at) " +
                "VALUES (?, ?, ?)")
        .use { stmt ->
          stmt.bindString(1, hash)
          stmt.bindBlob(2, plaintext)
          stmt.bindLong(3, System.currentTimeMillis())
          stmt.executeInsert()
        }
    db.execSQL(
        "DELETE FROM decrypt_cache WHERE created_at < ?",
        arrayOf<Any>(System.currentTimeMillis() - TTL_MS))
  }

  private fun sha256Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    val hex = "0123456789abcdef"
    val sb = StringBuilder(digest.size * 2)
    for (b in digest) {
      val v = b.toInt() and 0xFF
      sb.append(hex[v ushr 4])
      sb.append(hex[v and 0x0F])
    }
    return sb.toString()
  }
}
