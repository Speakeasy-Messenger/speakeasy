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
  // The RN bridge only accepts String, Boolean, Double, Integer, WritableMap,
  // WritableArray and null as a resolved value. The store's Kotlin
  // List<LinkedHashMap> must be converted to a WritableArray of WritableMaps here;
  // resolving it raw throws "Cannot convert argument of type class ..." at the JSI
  // boundary (every drain()/snapshot() in the diag-1.0.74-rc.2 upload failed this
  // way). Arguments.makeNativeMap walks the entries recursively — nested maps and
  // lists convert, Long/Float coerce to Double, and null values stay explicit
  // nulls (putNull), matching the store's deliberate missing-field discipline.
  @ReactMethod fun drain(promise: Promise) {
    val entries = AudioDiagnosticsStore.drain()
    val array = Arguments.createArray()
    for (entry in entries) array.pushMap(Arguments.makeNativeMap(entry))
    promise.resolve(array)
  }

  @ReactMethod fun snapshot(trigger: String, promise: Promise) {
    promise.resolve(Arguments.makeNativeMap(AudioDiagnosticsStore.snapshot(context, trigger)))
  }
  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit
}
