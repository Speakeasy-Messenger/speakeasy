package xyz.speakeasyapp.app.db

import android.content.Context
import dev.vouchflow.sdk.Vouchflow
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * SQLCipher-backed local DB. Phase 5c.
 *
 * # Key derivation (spec §4c)
 *
 * The SQLCipher passphrase is derived from the **Vouchflow device token**
 * via HKDF-SHA256:
 *
 *   IKM  = Vouchflow.cachedDeviceToken (UTF-8 bytes)
 *   salt = "speakeasy-db-v1"
 *   info = "sqlcipher-passphrase"
 *   OKM  = HKDF-SHA256(IKM, salt, info, 32 bytes)
 *
 * `cachedDeviceToken` is bytewise-stable per device — written once to
 * `AccountManager` during enrollment and read back unmodified on every
 * subsequent verify (Vouchflow Android SDK ≥ 1.0.3). It survives reboots
 * and app cold starts without biometric or network. The events that
 * rotate it are the events that should also rotate the local DB key:
 * biometric reconfiguration (`KEY_INVALIDATED`) and reinstall.
 *
 * # Bootstrap invariant
 *
 * The DB cannot open until enrollment has placed a token in
 * AccountManager. [open] throws [NotEnrolledException] if
 * `cachedDeviceToken` is null. The JS layer must drive
 * `vouchflow.verify({context: 'signup'})` before any Signal-store call.
 *
 * # Recovery
 *
 * Biometric reconfig destroys the local token → DB unreadable → app
 * triggers re-enrollment → fresh token → fresh DB. Out-of-band
 * re-enrollment recovers reputation server-side (Vouchflow returns the
 * prior token to a passed `existingDeviceToken`), but the local DB is
 * gone — equivalent to the device-wipe case. The salt + info are
 * versioned ("v1" / "speakeasy-db-v1") so a forward `PRAGMA rekey`
 * migration is straightforward if the derivation parameters ever change.
 */
object SpeakeasyDb {
  private const val DB_FILENAME = "speakeasy.db"
  private const val HKDF_SALT = "speakeasy-db-v1"
  private const val HKDF_INFO = "sqlcipher-passphrase"
  private const val PASSPHRASE_BYTES = 32
  private const val HMAC_ALG = "HmacSHA256"
  private const val HMAC_OUTPUT = 32

  class NotEnrolledException :
      IllegalStateException(
          "SpeakeasyDb cannot open: Vouchflow.cachedDeviceToken is null. " +
              "Run vouchflow.verify({context:'signup'}) before any Signal-store call.")

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
      val token = Vouchflow.shared.cachedDeviceToken ?: throw NotEnrolledException()
      val passphrase = derivePassphrase(token)
      val dbFile = context.getDatabasePath(DB_FILENAME)
      dbFile.parentFile?.mkdirs()
      val opened =
          SQLiteDatabase.openOrCreateDatabase(dbFile, passphrase, null, null, null)
      Schema.applyMigrations(opened)
      db = opened
      return opened
    }
  }

  /** Test-only: wipe in-process handle so the next `open()` reopens fresh. */
  fun closeForTest() {
    synchronized(this) {
      db?.close()
      db = null
    }
  }

  /**
   * Permanently delete the encrypted DB: close the handle and remove
   * the file plus its SQLite sidecars. Used by account deletion so a
   * later re-enrollment starts from a genuinely empty store instead of
   * resurrecting the previous identity's keys.
   */
  fun wipe(context: Context) {
    synchronized(this) {
      db?.close()
      db = null
      val dbPath = context.getDatabasePath(DB_FILENAME).path
      for (suffix in listOf("", "-journal", "-wal", "-shm")) {
        val f = File(dbPath + suffix)
        if (f.exists()) f.delete()
      }
    }
  }

  private fun ensureNativeLoaded() {
    if (!nativeLoaded) {
      System.loadLibrary("sqlcipher")
      nativeLoaded = true
    }
  }

  /** HKDF-SHA256 derivation. 32 bytes ≤ hash output, so single-block expand. */
  private fun derivePassphrase(deviceToken: String): ByteArray {
    val ikm = deviceToken.toByteArray(Charsets.UTF_8)
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
