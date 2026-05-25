package xyz.speakeasyapp.app.voicefilter

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import xyz.speakeasyapp.app.BuildConfig
import xyz.speakeasyapp.app.voicefilter.dsp.VoiceFilterDsp

/**
 * Speakeasy Voice Filter — Android side of the Phase 5j Private Call
 * native module. JS contract lives at `apps/mobile/src/native/voice-filter.ts`.
 *
 * `wrapTrack` installs a [VoiceFilterDsp] into the process-wide
 * [ActiveFilterHolder]. The forked
 * [org.webrtc.audio.WebRtcAudioRecord] reads the holder on every
 * captured frame and runs the DSP in-place before pushing to the
 * native ADM. `dispose` clears the holder and the next frame goes
 * through unfiltered (used when ending a Private Call cleanly).
 *
 * `isAvailable` stays gated on `BuildConfig.DEBUG` so the Private
 * row in CallTypeSheet only appears in dev builds until the founder
 * flips the release flag. The brand-promise failure-closed posture
 * lives in the JS shim's `isPrivateCallAvailable()` gate; this
 * module also rejects `wrapTrack` outside debug, and the WebRTC
 * fork mutes the mic on filter-process failure (latency-tripped,
 * RuntimeException, etc.) so unfiltered audio never reaches the
 * encoder.
 *
 * Error codes returned via `promise.reject(code, ...)` must stay in
 * the `FilterErrorCode` union in `voice-filter.ts`. The JS side maps
 * each to a typed `FilterError` the orchestrator switches on.
 */
class VoiceFilterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  init {
    // Phase 5j PR-G — make this module the singleton sink for the
    // forked WebRtcAudioRecord's feature events. The module is
    // created once by ReactPackage; the static holder lets the
    // audio-record thread fire events without needing a ref to the
    // ReactContext.
    instance = this
  }

  override fun getName(): String = NAME

  override fun getConstants(): Map<String, Any> = mapOf(
      // Phase 5j Private Call — exposed to RC testers in 0.7.0-rc.3+.
      // Was gated to `BuildConfig.DEBUG` only; the founder flipped
      // the flag for this RC so a release-signed APK can exercise
      // the full Private Call path on real hardware before the next
      // production cut. See PR-G2 commit message for the rationale.
      "isAvailable" to true,
  )

  @ReactMethod
  fun wrapTrack(trackId: String, promise: Promise) {
    // The JS shim doesn't actually need a new track id — the filter
    // wraps the same track's samples in place via the ADM fork. We
    // return the original id so the orchestrator's call to
    // `pc.addTrack(wrapped)` adds the same MediaStreamTrack handle,
    // and the AudioLevelMeter (which reads the unfiltered mic for
    // the user's own avatar) continues to work.
    val dsp = VoiceFilterDsp(semitones = DEFAULT_SHIFT_SEMITONES)
    ActiveFilterHolder.setFilter(dsp)
    val result = Arguments.createMap().apply {
      putString("filteredTrackId", trackId)
    }
    promise.resolve(result)
  }

  @ReactMethod
  fun dispose(promise: Promise) {
    // Idempotent. Clearing the holder makes the next captured frame
    // skip the filter — what the orchestrator wants when the user
    // hangs up cleanly. For a `latency_exceeded` mid-call failure
    // the orchestrator ends the call AND calls dispose; the WebRTC
    // fork's mute-on-fail behavior covers the in-flight frames.
    ActiveFilterHolder.setFilter(null)
    promise.resolve(null)
  }

  /**
   * Emit a single raw feature window to JS. Called from the forked
   * [org.webrtc.audio.WebRtcAudioRecord]'s AudioRecordThread after
   * the SampleFilter has run and [FeatureWindow] has filled. Posts
   * a `SpeakeasyVoiceFilterFeatures` device event the JS-side
   * `attachFeatureEventListener` consumes (and gates on the
   * orchestrator's active call kind so non-Private events are
   * dropped at the JS side, not here).
   *
   * Best-effort: if the bridge isn't ready or the catalyst is gone
   * we swallow rather than crashing the audio thread.
   */
  fun emitFeatures(loudness: Double, pitchHz: Double, zcr: Double, sampleRate: Double) {
    try {
      val ctx = reactApplicationContext
      if (!ctx.hasActiveReactInstance()) return
      val params = Arguments.createMap().apply {
        putDouble("loudness", loudness)
        putDouble("pitchHz", pitchHz)
        putDouble("zcr", zcr)
        putDouble("sampleRate", sampleRate)
      }
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_FEATURES, params)
    } catch (_: Throwable) {
      // Swallow — the audio-record thread must never throw or the
      // mic loop dies and the call goes silent.
    }
  }

  companion object {
    const val NAME = "SpeakeasyVoiceFilter"
    const val EVENT_FEATURES = "SpeakeasyVoiceFilterFeatures"

    /**
     * Default pitch + formant shift in semitones. Negative sounds
     * "deeper" / more disguised; the locked v1 plan picked this side.
     * Configurable from the orchestrator later (per call, per
     * peer) if the founder wants A/B testing.
     */
    private const val DEFAULT_SHIFT_SEMITONES = -2f

    /**
     * Static handle so the forked WebRtcAudioRecord (running on
     * the audio thread, no ReactContext access) can fire feature
     * events through the singleton VoiceFilterModule instance.
     * Assigned in the module's init {}; nulled by [setFilter]'s
     * disposal path is unnecessary because the module lives for
     * the app's lifetime.
     */
    @Volatile @JvmStatic var instance: VoiceFilterModule? = null
  }
}
