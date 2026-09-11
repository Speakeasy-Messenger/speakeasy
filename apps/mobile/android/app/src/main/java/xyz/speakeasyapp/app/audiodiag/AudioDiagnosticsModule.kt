package xyz.speakeasyapp.app.audiodiag

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AudioDiagnosticsModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  init { AudioDiagnosticsStore.initialize(context) }
  override fun getName(): String = "SpeakeasyAudioDiagnostics"

  @ReactMethod fun setCallId(callId: String?) = AudioDiagnosticsStore.setCallId(callId)
  @ReactMethod fun drain(promise: Promise) = promise.resolve(AudioDiagnosticsStore.drain())
  @ReactMethod fun snapshot(trigger: String, promise: Promise) =
    promise.resolve(AudioDiagnosticsStore.snapshot(context, trigger))
  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit
}
