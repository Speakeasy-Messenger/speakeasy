package xyz.speakeasyapp.app.pip

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import xyz.speakeasyapp.app.MainActivity

/**
 * Bridges the video-call screen's lifecycle to Android Picture-in-Picture.
 * JS calls [setVideoCallActive] when the video call screen mounts/unmounts;
 * while active, pressing Home floats the call into a PiP window (handled in
 * [MainActivity]). The native side emits `SpeakeasyPipModeChanged` so JS can
 * collapse the UI to just the video while in the PiP frame.
 */
class PipModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  @ReactMethod
  fun setVideoCallActive(active: Boolean) {
    val activity = currentActivity as? MainActivity
    if (activity == null) {
      // No activity yet — set the flag statically so onUserLeaveHint sees it.
      MainActivity.videoCallActive = active
      return
    }
    activity.runOnUiThread { activity.applyVideoCallActive(active) }
  }

  @ReactMethod
  fun setPipSession(sessionId: String?) {
    reactApplicationContext.getSharedPreferences("speakeasy_pip", 0)
      .edit()
      .apply {
        if (sessionId == null) remove("current_session") else putString("current_session", sessionId)
      }
      .apply()
  }

  @ReactMethod
  fun consumePendingPipClose(sessionId: String, promise: Promise) {
    val prefs = reactApplicationContext.getSharedPreferences("speakeasy_pip", 0)
    val pending = prefs.getBoolean("pending_close", false)
    val ageMs = System.currentTimeMillis() - prefs.getLong("pending_close_at", 0)
    val pendingSession = prefs.getString("pending_close_session", null)
    prefs.edit()
      .remove("pending_close")
      .remove("pending_close_at")
      .remove("pending_close_session")
      .apply()
    promise.resolve(pending && pendingSession == sessionId && ageMs in 0..30_000)
  }

  // Required so JS `NativeEventEmitter(SpeakeasyPip)` doesn't warn.
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    const val NAME = "SpeakeasyPip"
  }
}
