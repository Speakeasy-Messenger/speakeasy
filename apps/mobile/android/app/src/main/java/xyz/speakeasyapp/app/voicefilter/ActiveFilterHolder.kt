package xyz.speakeasyapp.app.voicefilter

/**
 * Process-wide singleton holding the currently-active voice filter
 * for capture audio. Read on every WebRTC audio frame from the
 * forked [org.webrtc.audio.WebRtcAudioRecord], written by
 * [VoiceFilterModule] when JS calls `wrapTrack` / `dispose`.
 *
 * The static singleton is intentional: the device has one mic, the
 * WebRTC `JavaAudioDeviceModule` is per-`PeerConnectionFactory` (and
 * react-native-webrtc creates one factory per app), and the brand
 * promise is that filtering is on or off at the moment audio is
 * captured. Threading a per-track filter through `WebRtcAudioRecord`
 * would require forking more of WebRTC's surface for no real
 * benefit — there's only ever one active call at a time.
 *
 * Volatile because the WebRTC audio-record thread reads it without
 * any synchronization; we accept the (rare) race where a call ends
 * while a frame is mid-flight by checking the returned `process`
 * boolean and muting the mic when the filter is gone or has tripped.
 */
object ActiveFilterHolder {
  @Volatile private var current: SampleFilter? = null

  /** Read by the WebRTC audio-record thread. May return null. */
  @JvmStatic
  fun getFilter(): SampleFilter? = current

  /** Install [filter] (or null to detach). Called by [VoiceFilterModule]. */
  @JvmStatic
  fun setFilter(filter: SampleFilter?) {
    current = filter
  }
}
