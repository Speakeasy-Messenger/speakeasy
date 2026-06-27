package xyz.speakeasyapp.app.db

import android.content.Context
import android.util.Base64
import android.util.Log
import dev.vouchflow.sdk.Vouchflow
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * SQLCipher-backed local DB. Phase 5c.
 *
 * # Key derivation (spec §4c)
 *
 * The SQLCipher passphrase is derived from a **db root secret** via
 * HKDF-SHA256:
 *
 *   IKM  = DbKeyStore root secret (UTF-8 bytes)
 *   salt = "speakeasy-db-v1"
 *   info = "sqlcipher-passphrase"
 *   OKM  = HKDF-SHA256(IKM, salt, info, 32 bytes)
 *
 * The root secret is generated once and frozen for the life of the
 * install — see [DbKeyStore]. It is **not** the Vouchflow device token.
 *
 * Earlier builds derived the passphrase straight from the device token.
 * That token rotates on biometric reconfiguration and Vouchflow
 * re-attestation, which silently re-keyed the database and made every
 * prior conversation unreadable (`file is not a database (code 26)`).
 * Decoupling the at-rest key from the attestation credential fixes
 * that: a fingerprint change no longer costs the user their message
 * history.
 *
 * # Bootstrap invariant
 *
 * [open] still throws [NotEnrolledException] when there is no Vouchflow
 * device token — not because the key needs it, but because an
 * un-enrolled app has no identity to store. The JS layer must drive
 * `vouchflow.verify({context: 'signup'})` before any Signal-store call.
 *
 * # First-launch wipe (intentional)
 *
 * The first launch with no [DbKeyStore] secret always seeds a **fresh
 * random** secret. If a database file already exists on disk it was
 * created by an older build (token-derived scheme) and we can't safely
 * guess the key it was made with — the token may have rotated since
 * enrollment. Earlier code tried to seed the secret with the current
 * device token to preserve history through the migration, but that
 * silently lost data the moment the token had moved, with no signal
 * to the user. The honest move is to wipe the orphan deterministically
 * and surface the reset to JS via [consumeResetFlag]. Every install
 * pays this once at upgrade; nothing wipes the DB afterwards.
 *
 * # Recovery
 *
 * If the file on disk cannot be decrypted with the current passphrase
 * (genuine corruption, lost Keystore key), [open] logs it, deletes the
 * file, sets the reset flag, and recreates an empty store so the app
 * stays usable. The lost contents are unrecoverable — recovery is
 * about not bricking the app, not about getting the data back.
 */
object SpeakeasyDb {
  private const val TAG = "SpeakeasyDb"
  private const val DB_FILENAME = "speakeasy.db"
  private const val HKDF_SALT = "speakeasy-db-v1"
  private const val HKDF_INFO = "sqlcipher-passphrase"
  private const val PASSPHRASE_BYTES = 32
  private const val HMAC_ALG = "HmacSHA256"
  private const val HMAC_OUTPUT = 32
  private const val ROOT_SECRET_BYTES = 32

  /** Plain SharedPreferences file (NOT the keystore-wrapped one) for
   *  the single boolean below — a UI hint, not a secret. */
  private const val STATE_PREFS = "speakeasy_db_state"
  private const val RESET_FLAG_KEY = "store_was_reset"

  class NotEnrolledException :
      IllegalStateException(
          "SpeakeasyDb cannot open: Vouchflow.cachedDeviceToken is null. " +
              "Run vouchflow.verify({context:'signup'}) before any Signal-store call.")

  /**
   * The db root secret couldn't be read this launch (Keystore unwrap failed /
   * couldn't persist), but it may still exist. We refuse to open rather than
   * wipe — the caller should retry. Retryable; NOT a data-loss condition.
   */
  class KeyUnavailableException(cause: Throwable?) :
      IllegalStateException(
          "SpeakeasyDb db root secret unavailable — refusing to wipe; retry later.", cause)

  @Volatile private var db: SQLiteDatabase? = null

  /** Native lib must be loaded once per process before opening any DB. */
  @Volatile private var nativeLoaded = false

  fun open(context: Context): SQLiteDatabase {
    db?.let {
      return it
    }
    synchronized(this) {
      db?.let {
        return it
      }
      ensureNativeLoaded()
      // The token gates "is the app enrolled at all" — it no longer
      // keys the database. See class doc.
      // Token gates "is the app enrolled at all"; it no longer keys the DB.
      Vouchflow.shared.cachedDeviceToken ?: throw NotEnrolledException()
      val dbFile = context.getDatabasePath(DB_FILENAME)
      dbFile.parentFile?.mkdirs()
      val passphrase = derivePassphrase(resolveRootSecret(context, dbFile))
      val opened = openOrRecover(context, dbFile, passphrase)
      Schema.applyMigrations(opened)
      db = opened
      return opened
    }
  }

  /**
   * Read-and-clear the "your local store was reset" flag. JS calls
   * this once at startup and shows the user a banner / diag entry
   * when it returns true. Returns false on a fresh install (no DB
   * was ever there) and on every normal launch.
   */
  fun consumeResetFlag(context: Context): Boolean {
    val prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
    val wasSet = prefs.getBoolean(RESET_FLAG_KEY, false)
    if (wasSet) prefs.edit().remove(RESET_FLAG_KEY).commit()
    return wasSet
  }

  /** Test-only: wipe in-process handle so the next `open()` reopens fresh. */
  fun closeForTest() {
    synchronized(this) {
      db?.close()
      db = null
    }
  }

  /**
   * Permanently delete the encrypted DB: close the handle, remove the
   * file plus its SQLite sidecars, and drop the db root secret. Used by
   * account deletion so a later re-enrollment starts from a genuinely
   * empty store instead of resurrecting the previous identity's keys.
   *
   * Does NOT set the reset flag — this path is user-initiated; the UI
   * already shows its own confirmation. The flag is for *unexpected*
   * resets only.
   */
  fun wipe(context: Context) {
    synchronized(this) {
      db?.close()
      db = null
      deleteDbFiles(context.getDatabasePath(DB_FILENAME))
      DbKeyStore.clear(context)
    }
  }

  /**
   * Resolve the db root secret, seeding [DbKeyStore] on first use.
   *
   * On a fresh install no DB file exists — seed with a random secret,
   * create an empty DB on first open, done. On the first launch after
   * upgrading from the old token-derived scheme a file exists but its
   * key is whatever token was current at the time of enrollment, and
   * we have no reliable way to reproduce it (the token may have
   * rotated). The deterministic move is to wipe the orphan, seed a
   * fresh random secret, and set the reset flag so JS can surface
   * the loss to the user.
   */
  private fun resolveRootSecret(context: Context, dbFile: File): String {
    when (val r = DbKeyStore.loadResult(context)) {
      is DbKeyStore.LoadResult.Found -> return r.secret
      is DbKeyStore.LoadResult.Unavailable -> {
        // The secret read FAILED (Keystore key invalidated / AEAD mismatch).
        // It may still be there — wiping now would destroy all history for a
        // transient error. Refuse to open; the caller retries. Core fix for
        // "messages deleted on update".
        Log.w(TAG, "db root secret unavailable — NOT wiping; will retry next open")
        throw KeyUnavailableException(r.error)
      }
      is DbKeyStore.LoadResult.Absent -> {
        // Definitively no secret. If a db file exists it's an orphan from the
        // old token-derived scheme we can't reproduce the key for — back it up
        // (don't destroy) and start fresh, surfacing the reset to JS.
        if (dbFile.exists()) {
          Log.w(TAG, "no db root secret + existing speakeasy.db — backing up orphan and starting fresh")
          backupDbFiles(dbFile)
          setResetFlag(context)
        }
        val seed = randomSecret()
        // Persist BEFORE creating the DB. If it can't be stored, don't create
        // a database we won't be able to re-key next launch (silent wipe loop).
        if (!DbKeyStore.store(context, seed)) {
          Log.w(TAG, "could not persist new db root secret — refusing to create an un-rekeyable DB")
          throw KeyUnavailableException(null)
        }
        return seed
      }
    }
  }

  /**
   * Open the database, recreating it empty if the file cannot be
   * decrypted with [passphrase]. Hits only on genuine corruption /
   * lost Keystore key after the install — the upgrade case is
   * already handled in [resolveRootSecret]. SQLCipher verifies the
   * key lazily, so a `SELECT` canary forces the check up front.
   */
  private fun openOrRecover(context: Context, dbFile: File, passphrase: ByteArray): SQLiteDatabase {
    var opened: SQLiteDatabase? = null
    try {
      opened = SQLiteDatabase.openOrCreateDatabase(dbFile, passphrase, null, null, null)
      opened.rawQuery("SELECT count(*) FROM sqlite_master", null).use { it.moveToFirst() }
      return opened
    } catch (e: Throwable) {
      opened?.close()
      if (!isWrongKey(e)) throw e
      // The secret loaded fine but the file won't decrypt with it (genuine
      // corruption / SQLCipher format change). Back the file up rather than
      // delete it — recoverable if we ever reproduce the key — then recreate
      // an empty store so the app stays usable.
      Log.w(TAG, "speakeasy.db unreadable with current key — backing up and recreating empty store", e)
      backupDbFiles(dbFile)
      setResetFlag(context)
      return SQLiteDatabase.openOrCreateDatabase(dbFile, passphrase, null, null, null)
    }
  }

  /** True when [e] is SQLCipher's wrong-passphrase signature. */
  private fun isWrongKey(e: Throwable): Boolean {
    val msg = "${e.message.orEmpty()} ${e.cause?.message.orEmpty()}"
    return msg.contains("file is not a database") || msg.contains("code 26")
  }

  /** Mark "the local store was reset" so JS can surface it next launch. */
  private fun setResetFlag(context: Context) {
    context
        .getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(RESET_FLAG_KEY, true)
        .commit()
  }

  /**
   * Delete the DB file and its `-journal` / `-wal` / `-shm` sidecars. Used
   * only by the user-initiated [wipe] (account deletion). The unexpected-reset
   * paths use [backupDbFiles] instead — never destroy data we weren't told to.
   */
  private fun deleteDbFiles(dbFile: File) {
    for (suffix in listOf("", "-journal", "-wal", "-shm")) {
      val f = File(dbFile.path + suffix)
      if (f.exists()) f.delete()
    }
  }

  /**
   * Move the DB file (and sidecars) aside instead of deleting it, so an
   * unexpected reset is recoverable rather than destructive. Single-slot: a
   * prior `.orphan` backup is removed first so it can't grow without bound.
   * Contents stay encrypted; this preserves them for a future recovery attempt.
   */
  private fun backupDbFiles(dbFile: File) {
    for (suffix in listOf("", "-journal", "-wal", "-shm")) {
      val src = File(dbFile.path + suffix)
      if (!src.exists()) continue
      val dst = File(dbFile.path + ".orphan" + suffix)
      if (dst.exists()) dst.delete()
      if (!src.renameTo(dst)) {
        // Fall back to delete so we don't leave a half-state blocking recreate.
        Log.w(TAG, "backup rename failed — deleting ${if (suffix.isEmpty()) "db" else suffix}")
        src.delete()
      }
    }
  }

  private fun ensureNativeLoaded() {
    if (!nativeLoaded) {
      System.loadLibrary("sqlcipher")
      nativeLoaded = true
    }
  }

  /** A fresh 32-byte random secret, Base64-encoded. */
  private fun randomSecret(): String {
    val bytes = ByteArray(ROOT_SECRET_BYTES)
    SecureRandom().nextBytes(bytes)
    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  /** HKDF-SHA256 derivation. 32 bytes ≤ hash output, so single-block expand. */
  private fun derivePassphrase(rootSecret: String): ByteArray {
    val ikm = rootSecret.toByteArray(Charsets.UTF_8)
    val salt = HKDF_SALT.toByteArray(Charsets.UTF_8)
    val info = HKDF_INFO.toByteArray(Charsets.UTF_8)
    val prk = hmacSha256(salt, ikm)
    // RFC 5869 expand: T(1) = HMAC(PRK, info || 0x01); OKM = T(1)[0..L]
    val t1Input = ByteArray(info.size + 1)
    System.arraycopy(info, 0, t1Input, 0, info.size)
    t1Input[info.size] = 0x01
    val t1 = hmacSha256(prk, t1Input)
    check(PASSPHRASE_BYTES <= HMAC_OUTPUT) { "single-block expand insufficient" }
    return t1.copyOfRange(0, PASSPHRASE_BYTES)
  }

  private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance(HMAC_ALG)
    mac.init(SecretKeySpec(key, HMAC_ALG))
    return mac.doFinal(data)
  }
}
