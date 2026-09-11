package xyz.speakeasyapp.app.audiodiag

import android.app.ActivityManager
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Bounded metadata-only handoff from WebRTC/InCallManager threads to JS diagnostics. */
object AudioDiagnosticsStore {
  private const val MAX_PENDING = 100
  private val lock = Any()
  private val pending = ArrayDeque<Map<String, Any?>>()
  @Volatile private var reactContext: ReactApplicationContext? = null
  @Volatile private var callId: String? = null

  fun initialize(context: ReactApplicationContext) { reactContext = context }
  fun setCallId(value: String?) { callId = value }

  @JvmStatic
  fun record(event: String, important: Boolean, fields: Map<String, Any?>) {
    val entry = LinkedHashMap<String, Any?>()
    entry["event"] = event
    entry["nativeElapsedMs"] = SystemClock.elapsedRealtime()
    entry["callId"] = callId
    entry["important"] = important
    entry.putAll(fields)
    val context = reactContext
    if (context?.hasActiveReactInstance() == true) {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("SpeakeasyAudioDiagnostics", Arguments.makeNativeMap(entry))
    } else {
      synchronized(lock) {
        pending.addLast(entry)
        while (pending.size > MAX_PENDING) pending.removeFirst()
      }
    }
  }

  fun drain(): List<Map<String, Any?>> = synchronized(lock) {
    val result = pending.toList()
    pending.clear()
    result
  }

  fun snapshot(context: ReactApplicationContext, trigger: String): Map<String, Any?> {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val activity = context.currentActivity
    val available = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      audio.getDevices(AudioManager.GET_DEVICES_ALL).map(::deviceType)
    } else null
    val effective = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.communicationDevice?.let(::deviceType)
    } else null
    return linkedMapOf(
      "event" to "platform snapshot",
      "trigger" to trigger,
      "nativeElapsedMs" to SystemClock.elapsedRealtime(),
      "callId" to callId,
      "mode" to audio.mode,
      "microphoneMuted" to audio.isMicrophoneMute,
      "speakerphoneOn" to audio.isSpeakerphoneOn,
      "effectiveCommunicationDevice" to effective,
      "availableDevices" to available,
      "appTopmost" to activity?.hasWindowFocus(),
      "microphoneForegroundService" to microphoneForegroundService(context),
    )
  }

  private fun microphoneForegroundService(context: Context): Boolean? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    return try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      @Suppress("DEPRECATION")
      manager.getRunningServices(Int.MAX_VALUE).any { service ->
        service.foreground && service.service.packageName == context.packageName &&
          service.service.className in setOf(
            "io.wazo.callkeep.VoiceConnectionService",
            "app.notifee.core.ForegroundService",
          )
      }
    } catch (_: SecurityException) { null }
  }

  @JvmStatic
  fun deviceType(device: AudioDeviceInfo?): String? = when (device?.type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth-sco"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth-a2dp"
    AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "usb"
    null -> null
    else -> "type-${device.type}"
  }
}
