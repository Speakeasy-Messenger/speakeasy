package xyz.speakeasyapp.app.db

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * RN bridge for the small bit of [SpeakeasyDb] state JS needs to observe.
 *
 * Currently exposes one method: [consumeResetFlag]. The native DB layer
 * sets a one-shot "the local store was reset" flag whenever it deletes
 * the encrypted file outside of a user-initiated wipe — either the
 * upgrade-time orphan cleanup or the lost-key recovery branch. The JS
 * layer reads-and-clears that flag at startup and surfaces a banner /
 * diag entry to the user, so a wipe is never silent.
 *
 * Kept in its own module rather than piggybacking on [SecureKvModule]
 * so the call site reads as "ask the DB if it reset itself," not "ask
 * the KV store about its parent."
 */
class SpeakeasyDbModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "SpeakeasyDb"

  @ReactMethod
  fun consumeResetFlag(promise: Promise) {
    try {
      promise.resolve(SpeakeasyDb.consumeResetFlag(ctx))
    } catch (e: Throwable) {
      promise.reject("speakeasy_db_consume_reset_flag_failed", e)
    }
  }
}
