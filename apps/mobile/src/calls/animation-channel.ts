import type { EmotionState } from './emotion-state-machine.js';

/**
 * Phase 5j Private Call — wire format for the per-frame animation
 * data the sender broadcasts to the receiver over the WebRTC data
 * channel at 30 Hz. The receiver applies these values directly to the
 * peer's avatar Render (mouth amplitude, eye scale, blink rate, per-
 * animal posture cues) so the animation feels driven by the peer's
 * actual speech — without ever decrypting their voice on this side.
 *
 * Why not derive on the receiver from the audio stream? `react-native-
 * webrtc` exposes no remote-audio sample tap on JS — audio frames go
 * straight to the speaker. Re-extracting features locally would need a
 * second native module shim per platform. Broadcasting from the
 * sender (who already computed them for their own self-avatar) is one
 * shim instead of two; see the plan's "Receiver-side amplitude —
 * data channel broadcast" lock.
 *
 * **Channel mode (locked):** `{ ordered: false, maxRetransmits: 0 }`.
 * Animation prefers fresh-or-drop over delivered-eventually; a network
 * blip = brief mouth idle then catch-up, NOT 200 ms of out-of-sync
 * lip-sync. Sequence number lets the receiver discard out-of-order
 * arrivals from the network (datachannels without `ordered` may
 * reorder).
 *
 * **Wire size:** 6 bytes per frame × 30 Hz = 180 B/s = 1.44 kbps —
 * about 1% of the audio bandwidth this rides alongside. Plan budget
 * was ~16 B/frame; we landed under that.
 */

/** Channel label — both sides negotiate by this name on `createDataChannel`. */
export const ANIMATION_CHANNEL_LABEL = 'speakeasy.private-call.animation';

/** Wire format version. Bumped if the layout changes. Receiver drops frames
 *  whose version it doesn't understand (forward-compat — old client doesn't
 *  pretend to handle future fields it can't parse). */
export const ANIMATION_FRAME_VERSION = 1;

/** Decoded shape — what the receiver-side store consumes. */
export interface AnimationFrame {
  /** Sequence counter; wraps at 2^16. Receiver uses for dedup + reorder. */
  seq: number;
  /** 0..1 — drives mouth scale on the peer's avatar Render. */
  amplitude: number;
  /** Categorical emotion state. */
  emotionState: EmotionState;
  /** 0..1 — same value the sender's AudioFeatureExtractor produced. */
  pitchNorm: number;
  /** 0..1 — same value the sender's AudioFeatureExtractor produced. */
  zcrNorm: number;
}

/**
 * Encode an AnimationFrame to a 6-byte payload.
 *
 * Layout (all little-endian where applicable):
 * ```
 * | 0           | 1         | 2          | 3        | 4-5      |
 * | hdr         | amplitude | pitch_norm | zcr_norm | seq u16  |
 * |  v: 4 bits  |   0..255  |   0..255   |  0..255  |          |
 * |  e: 4 bits  |           |            |          |          |
 * ```
 * `hdr` packs the wire version in the high nibble and the emotion
 * state enum in the low nibble (3 values today; 13 bits of headroom).
 */
export function encodeAnimationFrame(frame: AnimationFrame): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] =
    ((ANIMATION_FRAME_VERSION & 0x0f) << 4) |
    (encodeEmotionState(frame.emotionState) & 0x0f);
  buf[1] = clampByte(frame.amplitude * 255);
  buf[2] = clampByte(frame.pitchNorm * 255);
  buf[3] = clampByte(frame.zcrNorm * 255);
  const seq = frame.seq & 0xffff;
  buf[4] = seq & 0xff;
  buf[5] = (seq >> 8) & 0xff;
  return buf;
}

/** Decode a 6-byte payload. Returns `undefined` if the version is
 *  unrecognized, the length is wrong, or the emotion enum is unknown
 *  — same forward-compat posture as ignoring unknown WS frames. */
export function decodeAnimationFrame(
  buf: Uint8Array,
): AnimationFrame | undefined {
  if (buf.length !== 6) return undefined;
  const hdr = buf[0] ?? 0;
  const version = (hdr >> 4) & 0x0f;
  if (version !== ANIMATION_FRAME_VERSION) return undefined;
  const emotion = decodeEmotionState(hdr & 0x0f);
  if (!emotion) return undefined;
  return {
    seq: (buf[4] ?? 0) | ((buf[5] ?? 0) << 8),
    amplitude: (buf[1] ?? 0) / 255,
    emotionState: emotion,
    pitchNorm: (buf[2] ?? 0) / 255,
    zcrNorm: (buf[3] ?? 0) / 255,
  };
}

/**
 * Sequence-number dedup + reorder check. The data channel is
 * unordered (`ordered: false`), so a late-arriving frame may have a
 * lower seq than the most-recent one we accepted. Drop it — fresh-
 * or-drop. Handles the seq wrap-around at 2^16 via the half-window
 * trick: a new seq is "newer" if it's within 32768 ahead of the
 * last (mod 65536).
 *
 * Returns true if the caller should accept the frame.
 */
export function isFresherSeq(latest: number | undefined, incoming: number): boolean {
  if (latest === undefined) return true;
  const diff = (incoming - latest) & 0xffff;
  return diff > 0 && diff < 0x8000;
}

// ---------- internals ----------

function encodeEmotionState(state: EmotionState): number {
  switch (state) {
    case 'baseline':
      return 1;
    case 'excited':
      return 2;
    case 'calm':
      return 3;
  }
}

function decodeEmotionState(code: number): EmotionState | undefined {
  switch (code) {
    case 1:
      return 'baseline';
    case 2:
      return 'excited';
    case 3:
      return 'calm';
    default:
      return undefined;
  }
}

function clampByte(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}
