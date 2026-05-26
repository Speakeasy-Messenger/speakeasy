import type { AcousticEvent } from './audio-feature-extractor.js';

/**
 * Phase 5j Private Call — wire format for the per-frame animation
 * data the sender broadcasts to the receiver over the WebRTC data
 * channel at 30 Hz. The receiver applies these values directly to the
 * peer's avatar Render (mouth amplitude + shape, pitch-driven head
 * tilt, expressiveness-driven gesture amplitude, activity-driven
 * fidget rate, per-animal signature posture cues, dramatic event
 * overlays). The avatar feels driven by the peer's actual speech
 * — without ever decrypting their voice on this side.
 *
 * Why not derive on the receiver from the audio stream? `react-native-
 * webrtc` exposes no remote-audio sample tap on JS — audio frames go
 * straight to the speaker. Re-extracting features locally would need a
 * second native module shim per platform. Broadcasting from the
 * sender (who already computed them for their own self-avatar) is one
 * shim instead of two.
 *
 * **Wire format v2 (rc.11):** replaces the v1 discrete emotion enum
 * with **four continuous prosody channels** (mouthShape, pitchTrend,
 * expressiveness, activity) plus a small **acoustic-event** code
 * carried in the header's low nibble. The categorical
 * baseline/excited/calm enum is gone — continuous-feature → motion
 * mapping turned out to give more expressive avatar behavior than
 * any 3-state classification could, and feature extraction is
 * cheaper + more reliable than emotion classification. See the rc.11
 * "prosody-driven expression" change for the design rationale.
 *
 * **Channel mode (locked):** `{ ordered: false, maxRetransmits: 0 }`.
 * Animation prefers fresh-or-drop over delivered-eventually; a network
 * blip = brief mouth idle then catch-up, NOT 200 ms of out-of-sync
 * lip-sync. Sequence number lets the receiver discard out-of-order
 * arrivals from the network (datachannels without `ordered` may
 * reorder).
 *
 * **Wire size:** 10 bytes per frame × 30 Hz = 300 B/s = 2.4 kbps —
 * still ~1.5% of the audio bandwidth this rides alongside.
 */

/** Channel label — both sides negotiate by this name on `createDataChannel`. */
export const ANIMATION_CHANNEL_LABEL = 'speakeasy.private-call.animation';

/** Wire format version. Bumped to 2 in rc.11 (continuous prosody +
 *  acoustic events; v1 carried discrete emotion state). Receivers
 *  drop frames whose version they don't understand. */
export const ANIMATION_FRAME_VERSION = 2;

/** Decoded shape — what the receiver-side store consumes. All
 *  continuous channels are in their natural numeric range; pitchTrend
 *  is signed in [-1, 1], the rest are unsigned in [0, 1]. */
export interface AnimationFrame {
  /** Sequence counter; wraps at 2^16. Receiver uses for dedup + reorder. */
  seq: number;
  /** 0..1 — drives mouth Y scale on the peer's avatar Render. */
  amplitude: number;
  /** 0..1 — normalized pitch (F0). Same definition as v1. */
  pitchNorm: number;
  /** 0..1 — normalized ZCR. Same definition as v1. */
  zcrNorm: number;
  /** 0..1 — mouth-pose proxy; vowels open the mouth, fricatives don't. */
  mouthShape: number;
  /** -1..1 — pitch trend over ~200 ms; rising vs falling. */
  pitchTrend: number;
  /** 0..1 — pitch CoV over ~1 s; gesture-amplitude multiplier. */
  expressiveness: number;
  /** 0..1 — voiced-transition rate over ~1 s; fidget driver. */
  activity: number;
  /** One-shot event flag for dramatic beats. 'none' on most frames. */
  event: AcousticEvent;
}

/**
 * Encode an AnimationFrame to a 10-byte payload.
 *
 * Layout (all little-endian where applicable):
 * ```
 * | 0     | 1   | 2     | 3   | 4     | 5     | 6     | 7   | 8-9   |
 * | hdr   | amp | pitch | zcr | shape | trend | expr  | act | seq u16 |
 * | v: hi |     |       |     |       |  ±    |       |     |       |
 * | ev: lo|     |       |     |       |       |       |     |       |
 * ```
 * Header: version in the high nibble, event code in the low nibble
 * (0=none, 1=laugh, 2=sigh, 3=gasp, 4=hmm; 11 codes of headroom).
 * `pitchTrend` is signed → encoded as `(value + 1) × 127.5` so 0
 * lands at 128 in the byte. All other floats are unsigned ×255.
 */
export function encodeAnimationFrame(frame: AnimationFrame): Uint8Array {
  const buf = new Uint8Array(10);
  buf[0] =
    ((ANIMATION_FRAME_VERSION & 0x0f) << 4) |
    (encodeAcousticEvent(frame.event) & 0x0f);
  buf[1] = clampByte(frame.amplitude * 255);
  buf[2] = clampByte(frame.pitchNorm * 255);
  buf[3] = clampByte(frame.zcrNorm * 255);
  buf[4] = clampByte(frame.mouthShape * 255);
  buf[5] = clampByte((frame.pitchTrend + 1) * 127.5);
  buf[6] = clampByte(frame.expressiveness * 255);
  buf[7] = clampByte(frame.activity * 255);
  const seq = frame.seq & 0xffff;
  buf[8] = seq & 0xff;
  buf[9] = (seq >> 8) & 0xff;
  return buf;
}

/** Decode a 10-byte payload. Returns `undefined` if the version is
 *  unrecognized, the length is wrong, or the event enum is unknown
 *  — same forward-compat posture as ignoring unknown WS frames. */
export function decodeAnimationFrame(
  buf: Uint8Array,
): AnimationFrame | undefined {
  if (buf.length !== 10) return undefined;
  const hdr = buf[0] ?? 0;
  const version = (hdr >> 4) & 0x0f;
  if (version !== ANIMATION_FRAME_VERSION) return undefined;
  const event = decodeAcousticEvent(hdr & 0x0f);
  if (!event) return undefined;
  return {
    seq: (buf[8] ?? 0) | ((buf[9] ?? 0) << 8),
    amplitude: (buf[1] ?? 0) / 255,
    pitchNorm: (buf[2] ?? 0) / 255,
    zcrNorm: (buf[3] ?? 0) / 255,
    mouthShape: (buf[4] ?? 0) / 255,
    pitchTrend: ((buf[5] ?? 0) - 127.5) / 127.5,
    expressiveness: (buf[6] ?? 0) / 255,
    activity: (buf[7] ?? 0) / 255,
    event,
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

function encodeAcousticEvent(event: AcousticEvent): number {
  switch (event) {
    case 'none':
      return 0;
    case 'laugh':
      return 1;
    case 'sigh':
      return 2;
    case 'gasp':
      return 3;
    case 'hmm':
      return 4;
  }
}

function decodeAcousticEvent(code: number): AcousticEvent | undefined {
  switch (code) {
    case 0:
      return 'none';
    case 1:
      return 'laugh';
    case 2:
      return 'sigh';
    case 3:
      return 'gasp';
    case 4:
      return 'hmm';
    default:
      return undefined;
  }
}

function clampByte(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}
