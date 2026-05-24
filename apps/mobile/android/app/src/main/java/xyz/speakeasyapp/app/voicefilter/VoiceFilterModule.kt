package xyz.speakeasyapp.app.voicefilter

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import xyz.speakeasyapp.app.BuildConfig

/**
 * Speakeasy Voice Filter — Android side of the Phase 5j Private Call
 * native module. JS contract lives at `apps/mobile/src/native/voice-filter.ts`.
 *
 * **PR-A — skeleton only.** This module accepts the wrapTrack call and
 * returns the same track id back. There is no DSP wired up yet; the
 * job of this PR is to round-trip the bridge so the JS shim can read
 * `isAvailable`, await `wrapTrack`, and await `dispose` without crashing.
 * The real formant shifter + ±2 semitone pitch shift lands in PR-B.
 *
 * `isAvailable` is gated on `BuildConfig.DEBUG` so the Private row in
 * CallTypeSheet never appears in release builds until the DSP work
 * ships. The brand-promise gate (`failure-closed`) lives in the JS
 * shim — see `isPrivateCallAvailable()`.
 *
 * Error codes returned via `promise.reject(code, ...)` must stay in the
 * `FilterErrorCode` union in `voice-filter.ts`. The JS side maps each
 * to a typed `FilterError` the orchestrator switches on.
 */
class VoiceFilterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  override fun getConstants(): Map<String, Any> = mapOf(
      // Dev/debug builds only until PR-B lands the real DSP and PR-E
      // wires the orchestrator. Release builds stay invisible.
      "isAvailable" to BuildConfig.DEBUG,
  )

  @ReactMethod
  fun wrapTrack(trackId: String, promise: Promise) {
    if (!BuildConfig.DEBUG) {
      promise.reject("runtime_unavailable", "voice filter not built into release")
      return
    }
    // No-op skeleton — return the same track id. PR-B replaces this
    // with the JNI bridge into the C/Rust DSP that intercepts the
    // WebRTC ADM capture frames.
    val result = Arguments.createMap().apply {
      putString("filteredTrackId", trackId)
    }
    promise.resolve(result)
  }

  @ReactMethod
  fun dispose(promise: Promise) {
    // Idempotent. Nothing to release yet — PR-B will tear down the JNI
    // DSP engine and detach from the ADM capture path here.
    promise.resolve(null)
  }

  companion object {
    const val NAME = "SpeakeasyVoiceFilter"
  }
}
