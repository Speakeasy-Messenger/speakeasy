package xyz.speakeasyapp.app.audiodiag

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AudioDiagnosticsModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  init { AudioDiagnosticsStore.initialize(context) }
  override fun getName(): String = "SpeakeasyAudioDiagnostics"

  @ReactMethod fun setCallId(callId: String?) = AudioDiagnosticsStore.setCallId(callId)
  @ReactMethod fun drain(promise: Promise) {
    val array = Arguments.createArray()
    populateBridgeArray(array, AudioDiagnosticsStore.drain())
    promise.resolve(array)
  }

  @ReactMethod fun snapshot(trigger: String, promise: Promise) {
    val map = Arguments.createMap()
    populateBridgeMap(map, AudioDiagnosticsStore.snapshot(context, trigger))
    promise.resolve(map)
  }
  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit
}
