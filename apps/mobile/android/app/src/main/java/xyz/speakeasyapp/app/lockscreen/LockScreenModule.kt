package xyz.speakeasyapp.app.lockscreen

import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
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

  /**
   * Whether the device has a secure lock screen — a PIN, pattern,
   * password, OR an enrolled biometric (fingerprint/face). This is exactly
   * the "passkey" Vouchflow's attestation needs: with no lock, device
   * verification can't reach the production confidence floor, so signup
   * fails `low_confidence`. The onboarding flow checks this to guide the
   * user to set up a lock instead of dead-ending — and to tell apart "no
   * lock" from "has a lock but the device is otherwise un-attestable".
   */
  @ReactMethod
  fun isDeviceSecure(promise: Promise) {
    val km = reactContext.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    promise.resolve(km?.isDeviceSecure ?: false)
  }

  /** Open the system security settings so the user can set up a lock.
   *  `DevicePolicyManager.ACTION_SET_NEW_PASSWORD` jumps straight to the
   *  set-credential flow on every supported API; if an OEM restricts it we
   *  fall back to the general security settings page below. */
  @ReactMethod
  fun openSecuritySettings(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    val intent = Intent(DevicePolicyManager.ACTION_SET_NEW_PASSWORD)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      // Some OEMs restrict ACTION_SET_NEW_PASSWORD — fall back to the
      // general security settings page.
      try {
        val fallback = Intent(Settings.ACTION_SECURITY_SETTINGS)
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(fallback)
        promise.resolve(true)
      } catch (e2: Exception) {
        promise.resolve(false)
      }
    }
  }
}
