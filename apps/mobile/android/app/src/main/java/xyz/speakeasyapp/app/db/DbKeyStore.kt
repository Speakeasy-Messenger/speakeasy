package xyz.speakeasyapp.app.db

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stable secret that seeds the [SpeakeasyDb] SQLCipher passphrase.
 *
 * # Why this exists
 *
 * The DB passphrase used to be HKDF-derived directly from the Vouchflow
 * **device token**. The device token is an attestation credential: it
 * rotates on biometric/lock-screen reconfiguration (`KEY_INVALIDATED`)
 * and on reinstall. Tying the data-at-rest key to it meant any one of
 * those events silently re-keyed the database — SQLCipher then refused
 * the old file with `file is not a database (code 26)` and the user
 * lost every conversation, with no recovery path. Reported 2026-05-19
 * (@dinnertray: "lost all my conversations", `session_init_failed`).
 *
 * # What this does instead
 *
 * The passphrase is now derived from a **db root secret** that is
 * generated once and never changes for the life of the install. The
 * secret is kept confidential at rest by wrapping it with an
 * AES-256-GCM key held in the `AndroidKeyStore`:
 *
 *   - The keystore key is hardware-backed where available and is
 *     **not** auth-bound (`setUserAuthenticationRequired` is never
 *     set), so biometric re-enrollment does NOT invalidate it. That is
 *     the whole point — a fingerprint change must not cost the user
 *     their message history.
 *   - The wrapped secret (IV ‖ ciphertext, Base64) lives in a plain
 *     `SharedPreferences` file. It is useless without the keystore key.
 *
 * The secret is app-scoped: it does not survive uninstall or
 * "clear data", which is the intended policy (reinstall = fresh start,
 * same as Signal/WhatsApp — see `backup_rules.xml`).
 *
 * # Migration
 *
 * On the first open after upgrading from the token-derived scheme,
 * [SpeakeasyDb] seeds this store with the *current* device token, so
 * the derivation output is byte-identical to the old key and the
 * existing database opens unchanged. From that point on the secret is
 * frozen and token rotation is irrelevant. If the token is already
 * gone at upgrade time, the legacy DB is unrecoverable anyway and the
 * recovery path in [SpeakeasyDb.open] recreates it.
 */
object DbKeyStore {
  private const val TAG = "DbKeyStore"
  private const val PREFS_FILE = "speakeasy_db_root"
  private const val PREF_KEY = "wrapped_secret"
  private const val KEYSTORE_ALIAS = "speakeasy_db_root_v1"
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  private const val AES_GCM = "AES/GCM/NoPadding"
  private const val GCM_TAG_BITS = 128
  private const val GCM_IV_BYTES = 12

  /**
   * Outcome of a root-secret read. [Absent] (no prefs entry) is the safe
   * "fresh install" path where seeding is correct; [Unavailable] (the wrapped
   * secret IS present but unwrap failed — Keystore key invalidated, AEAD tag
   * mismatch) means the secret may still be recoverable and the caller MUST
   * NOT wipe the DB. Conflating these was the cause of "messages deleted on
   * update".
   */
  sealed class LoadResult {
    data class Found(val secret: String) : LoadResult()
    object Absent : LoadResult()
    data class Unavailable(val error: Throwable) : LoadResult()
  }

  /** Read the db root secret, distinguishing "no entry" from "unwrap failed". */
  fun loadResult(context: Context): LoadResult {
    val wrapped =
        context
            .getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .getString(PREF_KEY, null) ?: return LoadResult.Absent
    return try {
      LoadResult.Found(unwrap(Base64.decode(wrapped, Base64.NO_WRAP)))
    } catch (e: Throwable) {
      // The wrapped secret IS present but couldn't be decrypted (Keystore key
      // invalidated / AEAD failure / corrupt blob). This is NOT a fresh
      // install — never wipe on it.
      Log.w(TAG, "unwrap failed — secret present but unreadable; will NOT wipe", e)
      LoadResult.Unavailable(e)
    }
  }

  /**
   * The persisted db root secret, or `null` if absent **or unreadable**.
   * Prefer [loadResult] on the open path so a transient unwrap failure isn't
   * mistaken for "fresh install" and used to justify a wipe.
   */
  fun load(context: Context): String? =
      (loadResult(context) as? LoadResult.Found)?.secret

  /**
   * Persist [secret] as the db root secret. Returns `true` iff it is now
   * durably stored (verified by read-back); `false` means the caller must not
   * create a DB it can't re-key next launch.
   */
  fun store(context: Context, secret: String): Boolean {
    return try {
      val wrapped = Base64.encodeToString(wrap(secret), Base64.NO_WRAP)
      val committed =
          context
              .getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
              .edit()
              .putString(PREF_KEY, wrapped)
              .commit()
      committed && load(context) == secret
    } catch (e: Throwable) {
      Log.w(TAG, "store failed — db root secret NOT persisted", e)
      false
    }
  }

  /**
   * Drop the wrapped secret. Used by account deletion alongside
   * [SpeakeasyDb.wipe] so a later re-enrollment starts from a genuinely
   * empty store. The keystore key is left in place — harmless without
   * the ciphertext, and reused if the user re-onboards.
   */
  fun clear(context: Context) {
    context
        .getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        .edit()
        .remove(PREF_KEY)
        .commit()
  }

  /** GCM-encrypt [secret]; output is IV ‖ ciphertext. */
  private fun wrap(secret: String): ByteArray {
    val cipher = Cipher.getInstance(AES_GCM)
    cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
    val iv = cipher.iv
    val ct = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
    return iv + ct
  }

  /** Reverse [wrap]: split IV ‖ ciphertext and GCM-decrypt. */
  private fun unwrap(blob: ByteArray): String {
    val iv = blob.copyOfRange(0, GCM_IV_BYTES)
    val ct = blob.copyOfRange(GCM_IV_BYTES, blob.size)
    val cipher = Cipher.getInstance(AES_GCM)
    cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
    return String(cipher.doFinal(ct), Charsets.UTF_8)
  }

  /** Fetch the wrapping key from the keystore, generating it on first use. */
  @Synchronized
  private fun keystoreKey(): SecretKey {
    val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    (ks.getEntry(KEYSTORE_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
      return it.secretKey
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
        KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // Deliberately NOT setUserAuthenticationRequired(true): the
            // key must survive biometric re-enrollment. See class doc.
            .build())
    return generator.generateKey()
  }
}
