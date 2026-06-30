package xyz.speakeasyapp.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import com.facebook.react.ReactActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import xyz.speakeasyapp.app.notif.NotifMessagingModule
import xyz.speakeasyapp.app.share.ShareModule

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
    // Notification tap that launched the Activity from a quit state —
    // stash the extras for JS to consume once the bundle is up.
    NotifMessagingModule.stashTap(intent)
    ShareModule.stashShare(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // Notification tap while the Activity was already running (warm
    // resume). JS polls `consumePendingTap` on the next AppState
    // 'active' so the tap routes the same way as a cold start.
    NotifMessagingModule.stashTap(intent)
    ShareModule.stashShare(intent)
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

  // ----- Picture-in-Picture (background video calls) -----------------
  //
  // While a video call is on screen, pressing Home should float the call
  // into a PiP window instead of suspending it (the camera stops in the
  // background either way, but the remote video keeps playing). JS toggles
  // `videoCallActive` via SpeakeasyPip.setVideoCallActive when the video
  // call screen mounts/unmounts.

  // Named distinctly from the `videoCallActive` property to avoid a JVM
  // signature clash with its generated static setter.
  fun applyVideoCallActive(active: Boolean) {
    videoCallActive = active
    // Android 12+ auto-enters PiP on Home when params say so — no
    // onUserLeaveHint needed. Refresh the params to reflect the new state.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        setPictureInPictureParams(buildPipParams())
      } catch (_: IllegalStateException) {
        // Activity not in a state that accepts PiP params — ignore.
      }
    }
  }

  private fun buildPipParams(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      // Portrait-ish call window. Android clamps to its allowed range.
      .setAspectRatio(Rational(9, 16))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(videoCallActive)
    }
    return builder.build()
  }

  // Pre-Android-12 fallback: explicitly enter PiP when the user leaves
  // (Home / app-switcher) during a video call. On 12+ autoEnter handles it.
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (
      videoCallActive &&
      Build.VERSION.SDK_INT in Build.VERSION_CODES.O until Build.VERSION_CODES.S &&
      !isInPictureInPictureMode
    ) {
      try {
        enterPictureInPictureMode(buildPipParams())
      } catch (_: IllegalStateException) {
        /* can't enter right now — ignore */
      }
    }
  }

  // Tell JS so the call UI can collapse to just the video in the PiP
  // window (hide controls/handle that don't fit the small frame).
  // True between exiting PiP and the next lifecycle settle, so onStop vs
  // onResume can tell a DISMISS (user closed the bubble → onStop) from an
  // EXPAND (user reopened the app → onResume).
  private var exitingPip = false

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    emitJsEvent("SpeakeasyPipModeChanged", isInPictureInPictureMode)
    if (isInPictureInPictureMode) {
      // Hand JS the authoritative PiP window size so the video SurfaceView is
      // recreated at the true bubble size (see emitPipSize).
      emitPipSize(newConfig)
    } else {
      // Exiting PiP — but we don't yet know if it's a dismiss or an expand.
      // onResume (expand) clears this; onStop (dismiss) acts on it.
      exitingPip = true
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // While floating in PiP the user can resize the bubble. Android delivers
    // the new window size HERE — onPictureInPictureModeChanged only fires on
    // enter/exit, not on a resize — so without this the JS side never learns
    // the bubble grew. RN's own onLayout frequently reports a stale (pre-resize)
    // size inside a PiP window, which left the SurfaceView holding its old
    // buffer: the reported "video only fills a corner / lags resizing to fit".
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode) {
      emitPipSize(newConfig)
    }
  }

  // Emit the PiP window size in DP — which is exactly React Native's layout
  // unit, so JS can key/size the video view directly with no px conversion.
  // screenWidthDp/screenHeightDp track the floating window (not the display)
  // while in PiP, and are available on every API level we ship.
  private fun emitPipSize(config: Configuration) {
    val map = Arguments.createMap().apply {
      putInt("width", config.screenWidthDp)
      putInt("height", config.screenHeightDp)
    }
    emitJsEvent("SpeakeasyPipResize", map)
  }

  override fun onResume() {
    super.onResume()
    // Reopened into the app — not a dismiss. Don't end the call.
    exitingPip = false
  }

  override fun onStop() {
    super.onStop()
    if (exitingPip) {
      // The user CLOSED the PiP bubble (didn't expand it). End the call so the
      // camera/mic/dial tone don't keep running headless (reported: "close the
      // bubble, the call keeps going"). JS hangs up on this event.
      exitingPip = false
      emitJsEvent("SpeakeasyPipClosed", true)
    }
  }

  private fun emitJsEvent(name: String, value: Any) {
    try {
      // Bridgeless (new arch): the live JS context is on `reactHost`, NOT
      // `reactNativeHost.reactInstanceManager` — that's the legacy bridge path
      // and is null under bridgeless, so the old chain silently no-op'd EVERY
      // emit. That's why SpeakeasyPipModeChanged never reached JS (inPip never
      // flipped → the call overlay stayed drawn inside the small PiP window =
      // the "bubble dimension error") and SpeakeasyPipClosed never fired
      // (dismissing the bubble didn't end the call).
      val ctx = (application as? MainApplication)?.reactHost?.currentReactContext
      ctx
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit(name, value)
    } catch (_: Throwable) {
      /* best-effort */
    }
  }

  companion object {
    /** Set by JS while a video call screen is on top. Read on Home-press. */
    @JvmStatic
    var videoCallActive: Boolean = false
  }
}