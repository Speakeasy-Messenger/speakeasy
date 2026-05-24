package xyz.speakeasyapp.app.voicefilter

/**
 * Per-frame interface the Phase 5j Private Call DSP exposes to whoever
 * is driving capture samples (PR-B2's forked WebRTC `AudioDeviceModule`).
 *
 * Contract:
 *   - `process` is called on the WebRTC audio-record thread, once per
 *     ~10ms capture frame. Mono PCM16, little-endian, in-place.
 *   - The callee MAY mutate `samples` and `frameSizeBytes` (the latter
 *     stays equal to input for this v1; reserved for time-stretching
 *     filters in v2).
 *   - The callee MUST NOT block; the WebRTC encoder runs immediately
 *     after `process` returns.
 *   - The callee MUST be allocation-free in the hot path. The
 *     [VoiceFilterDsp] implementation pre-allocates all buffers in its
 *     constructor.
 *
 * `isFiltering` flips at call boundaries: false outside a Private
 * Call (filter is bypassed; `process` is a no-op), true while a
 * Private Call is active. The toggle lives in [VoiceFilterModule] and
 * is observed by PR-B2's fork via a singleton.
 */
interface SampleFilter {
  /**
   * Filter one capture frame in place.
   *
   * @param samples little-endian PCM16 in a `ByteBuffer` (direct or
   *   heap-backed). The caller owns the buffer; do not retain it.
   * @param sampleRateHz e.g. 48000 — read from WebRTC's negotiated rate
   * @param channelCount 1 or 2; v1 collapses stereo→mono before
   *   filtering and writes the same mono samples back to both channels
   * @return true if the buffer was processed, false if the filter
   *   was bypassed (caller can skip latency accounting)
   */
  fun process(
      samples: java.nio.ByteBuffer,
      sampleRateHz: Int,
      channelCount: Int,
  ): Boolean
}
