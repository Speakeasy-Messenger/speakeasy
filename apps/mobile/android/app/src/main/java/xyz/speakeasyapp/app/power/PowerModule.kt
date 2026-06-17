package xyz.speakeasyapp.app.power

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Battery-optimization (Doze / App-Standby) exemption helper.
 *
 * Why this exists: Speakeasy's Android push for 'rich' devices is
 * **data-only** so the headless FCM handler can decrypt the forwarded
 * ciphertext and render the real message text. But a data-only message
 * needs that handler to RUN, and Android defers — or kills the process
 * for — a battery-optimized app in Doze / App-Standby. The result is the
 * "batch of delayed notifications when I foreground the app" report: the
 * pushes were accepted by FCM but the handler never ran in the
 * background, so nothing showed until the WS drained on foreground.
 *
 * Whitelisting the app from battery optimization lets high-priority FCM
 * pushes wake it in the background. We do NOT use the one-tap
 * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` dialog: it requires the
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission, which Google Play
 * restricts to a narrow allow-list (VoIP / fitness / navigation / IoT)
 * and rejects general messaging apps for declaring. Instead we read the
 * current state with `PowerManager.isIgnoringBatteryOptimizations()` (no
 * permission needed) and, when the user opts in, deep-link to the system
 * battery-optimization settings so they can flip it themselves. Surfaced
 * via a one-time, dismissable in-app nudge — see
 * src/components/BatteryOptBanner.tsx.
 */
class PowerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SpeakeasyPower"

  /**
   * Whether the app is already exempt from battery optimization. Resolves
   * `true` (the "nothing to fix" answer) if PowerManager is unavailable,
   * so the in-app nudge stays hidden rather than prompting pointlessly.
   */
  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    val pm = reactContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
    promise.resolve(pm?.isIgnoringBatteryOptimizations(reactContext.packageName) ?: true)
  }

  /**
   * Open the system battery-optimization settings so the user can mark
   * Speakeasy as unrestricted. Uses the permission-free
   * `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` list (the dedicated
   * battery-optimization screen); falls back to this app's details page
   * on OEMs that don't expose that list action. Deliberately NOT the
   * one-tap `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` dialog — that
   * needs the Play-restricted permission (see class doc).
   */
  @ReactMethod
  fun requestDisableBatteryOptimization(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    try {
      val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      try {
        val fallback =
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:" + reactContext.packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(fallback)
        promise.resolve(true)
      } catch (e2: Exception) {
        promise.resolve(false)
      }
    }
  }
}
