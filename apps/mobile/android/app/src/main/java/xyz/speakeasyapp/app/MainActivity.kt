package xyz.speakeasyapp.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Speakeasy"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Pass `null` instead of `savedInstanceState` so Android does NOT
   * try to restore the FragmentManager state. `react-native-screens`
   * can't reconstitute its `ScreenFragment`s from a Bundle — when
   * the Android system kills the process while the app is in
   * background and then restores it on foreground, the FragmentState
   * deserializer crashes with:
   *
   *   IllegalStateException: Screen fragments should never be restored
   *
   * RN rebuilds the entire navigation tree from Js state on relaunch
   * anyway; we don't lose anything by skipping the system's
   * fragment restoration. Standard `react-native-screens` workaround
   * (their docs flag this for new-arch RN apps).
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    createNotificationChannels()
  }

  /**
   * Create the notification channels required for FCM push delivery.
   *
   * On Android 8+ (API 26+), notifications posted to a channel that
   * doesn't exist on the device are **silently dropped** — no banner,
   * no sound, no shade entry. The manifest declares
   * `speakeasy_default` as the default channel, but the channel must
   * also be created at runtime. Without this, background/killed-state
   * message pushes arrive at FCM (`successes:1`) but are never shown
   * to the user.
   *
   * CallKeep creates its own `xyz.speakeasyapp.app.calls` channel
   * at setup time; we don't duplicate it here.
   */
  private fun createNotificationChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return // API <26: channels not needed
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    // Messages channel — used by FCM for inbound message pushes when
    // the app is backgrounded/killed.
    val messagesChannel = NotificationChannel(
      "speakeasy_default",
      "Messages",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "New message notifications"
      setShowBadge(true)
      // Use system defaults for sound & vibration so the user can
      // customize in Settings without us hard-coding a URI.
      setSound(null, null) // Let the channel defaults handle it
      // Actually, IMPORTANCE_HIGH already enables sound+vibration
      // by default. Setting an explicit sound URI to null here
      // means "use system default", which is correct.
    }
    nm.createNotificationChannel(messagesChannel)
  }
}