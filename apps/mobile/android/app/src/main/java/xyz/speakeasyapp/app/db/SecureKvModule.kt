package xyz.speakeasyapp.app.db

import android.content.ContentValues
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import net.zetetic.database.sqlcipher.SQLiteDatabase

/**
 * RN bridge for an encrypted key-value store, backed by the `kv` table
 * in the SQLCipher [SpeakeasyDb].
 *
 * Why this exists: the decrypted conversation history used to be
 * persisted to AsyncStorage, which on Android is an unencrypted SQLite
 * file. The Signal keys already live in the SQLCipher DB; the message
 * bodies belong there too. `store/conversations.ts` persists its JSON
 * blob through this module instead.
 *
 * The DB only opens once enrollment has placed a Vouchflow device
 * token (its passphrase is HKDF-derived from that token — see
 * SpeakeasyDb). Calls before enrollment reject; the JS layer treats a
 * rejection as "nothing persisted yet" and carries on with in-memory
 * state — conversations only exist post-enrollment anyway.
 *
 * Values cross the bridge as UTF-8 strings (the caller persists JSON)
 * and are stored as BLOB.
 */
class SecureKvModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "SecureKv"

  @ReactMethod
  fun get(key: String, promise: Promise) {
    try {
      val db = SpeakeasyDb.open(ctx)
      db.rawQuery("SELECT value FROM kv WHERE key = ?", arrayOf(key)).use { cursor ->
        if (cursor.moveToFirst()) {
          promise.resolve(String(cursor.getBlob(0), Charsets.UTF_8))
        } else {
          promise.resolve(null)
        }
      }
    } catch (e: Throwable) {
      promise.reject("secure_kv_get_failed", e)
    }
  }

  @ReactMethod
  fun set(key: String, value: String, promise: Promise) {
    try {
      val db = SpeakeasyDb.open(ctx)
      val values =
          ContentValues().apply {
            put("key", key)
            put("value", value.toByteArray(Charsets.UTF_8))
          }
      db.insertWithOnConflict("kv", null, values, SQLiteDatabase.CONFLICT_REPLACE)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("secure_kv_set_failed", e)
    }
  }

  @ReactMethod
  fun delete(key: String, promise: Promise) {
    try {
      val db = SpeakeasyDb.open(ctx)
      db.delete("kv", "key = ?", arrayOf(key))
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("secure_kv_delete_failed", e)
    }
  }
}
