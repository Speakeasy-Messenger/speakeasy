package xyz.speakeasyapp.app.share

import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Receives ACTION_SEND (text) intents from the Android system share sheet,
 * so other apps can "Share → Speakeasy". MainActivity.onCreate/onNewIntent
 * stash the shared text here; JS drains it via consumePendingShare on the
 * next AppState 'active' and opens a "Send to…" picker. Mirrors the notif
 * tap stash pattern in NotifMessagingModule.
 *
 * Text only for now (links / selected text). Image/file shares need a
 * ContentResolver copy before the grant expires — a follow-up.
 */
class ShareModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  @ReactMethod
  fun consumePendingShare(promise: Promise) {
    val text = pendingText
    pendingText = null
    if (text == null) {
      promise.resolve(null)
      return
    }
    val map = Arguments.createMap()
    map.putString("text", text)
    promise.resolve(map)
  }

  // Required for NativeEventEmitter symmetry (unused today).
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    const val NAME = "SpeakeasyShare"

    /** Shared text awaiting JS pickup; set by MainActivity, drained by JS. */
    @Volatile
    private var pendingText: String? = null

    /**
     * Pull the shared text out of an ACTION_SEND intent and stash it. Safe to
     * call on any intent — no-op for non-share intents. Called from
     * MainActivity.onCreate (cold) and onNewIntent (warm).
     */
    fun stashShare(intent: Intent?) {
      if (intent == null) return
      if (intent.action != Intent.ACTION_SEND) return
      if (intent.type != "text/plain") return
      val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
      if (text.isBlank()) return
      pendingText = text
    }
  }
}
