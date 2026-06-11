package xyz.speakeasyapp.app.lockscreen

import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Toggles whether the Activity may show over the keyguard (lock screen)
 * and turn the screen on — **on demand**, only while an incoming/active
 * call needs it.
 *
 * Why this exists (the bug it fixes): these used to be static
 * `android:showWhenLocked="true"` / `android:turnScreenOn="true"`
 * attributes on MainActivity in AndroidManifest.xml. Static attributes
 * apply to the WHOLE app for its entire lifetime, so anything that
 * woke the screen with Speakeasy foregrounded — e.g. locking the device
 * on the chat list, then tapping power — rendered the chat list ON TOP
 * of the lock screen. That's a privacy leak: a locked phone showed the
 * user's conversations.
 *
 * The Android-recommended pattern (API 27+) is to set these flags
 * programmatically and clear them when no longer needed, so the
 * over-lockscreen behaviour is scoped to exactly the moment a call is
 * ringing/connected. The JS call layer enables it on `incoming_ringing`
 * (and keeps it through a connected call) and disables it when the call
 * ends — see apps/mobile/src/native/lock-screen.ts.
 *
 * On API < 27 (Android 7.1 and below) `setShowWhenLocked` /
 * `setTurnScreenOn` don't exist; we no-op. Speakeasy's minSdk is well
 * above that in practice, but the guard keeps the module safe.
 */
class LockScreenModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SpeakeasyLockScreen"

  @ReactMethod
  fun setShowWhenLocked(enabled: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return // API < 27: APIs unavailable
    val activity = currentActivity ?: return
    activity.runOnUiThread {
      activity.setShowWhenLocked(enabled)
      activity.setTurnScreenOn(enabled)
    }
  }
}
