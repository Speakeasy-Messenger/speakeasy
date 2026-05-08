import type {
  CallAnswerPayload,
  CallEndReason,
  CallIceCandidate,
  CallIcePayload,
  CallOfferPayload,
} from '@speakeasy/shared';

/**
 * Local-only call lifecycle state. The orchestrator drives transitions;
 * `useCallStore` mirrors this for UI.
 */
export type CallStage =
  | 'idle'
  | 'outgoing_dialing' // we sent the offer, waiting for the wire to settle
  | 'outgoing_ringing' // peer's device acknowledged it received the offer
  | 'incoming_ringing' // we received an offer, user hasn't answered yet
  | 'connecting' // SDP exchanged, ICE/DTLS in progress
  | 'connected' // media flowing
  | 'ended';

/**
 * Wire reasons (`hangup`/`decline`/`cancel`/`busy`) plus local-only
 * synthetic states the orchestrator records but never sends.
 */
export type CallEndedReason =
  | CallEndReason
  | 'no_answer'
  | 'callee_offline'
  | 'completed'
  | 'failed';

export interface ActiveCall {
  callId: string;
  peerUserId: string;
  /** Was this device the caller (true) or callee (false)? */
  isCaller: boolean;
  stage: CallStage;
  /** When the call entered its current stage. */
  stageEnteredAt: number;
  /** Set once `connected` first fires — used to compute duration. */
  connectedAt?: number;
  /** Final reason, set when stage transitions to `ended`. */
  endedReason?: CallEndedReason;
  /** Mute state of the local mic. */
  micMuted: boolean;
  /** Speakerphone routing toggle (vs earpiece). */
  speakerOn: boolean;
}

/**
 * Mockable WebRTC peer. Real impl wraps `react-native-webrtc`'s
 * `RTCPeerConnection`. Tests use an in-memory pair so the state
 * machine can be exercised on Linux without native deps.
 *
 * The orchestrator never sees raw SDP — only the structured payloads
 * the shared types define, which keeps wire format + crypto wrapping
 * decoupled from the WebRTC adapter.
 */
export interface CallPeer {
  /** Caller side: produce the offer. */
  createOffer(): Promise<CallOfferPayload>;
  /** Callee side: ingest the offer (SDP + initial ICE). */
  setRemoteOffer(payload: CallOfferPayload): Promise<void>;
  /** Callee side: produce the answer. */
  createAnswer(): Promise<CallAnswerPayload>;
  /** Caller side: ingest the answer. */
  setRemoteAnswer(payload: CallAnswerPayload): Promise<void>;
  /** Either side: ingest trickled ICE candidates. */
  addRemoteIce(payload: CallIcePayload): Promise<void>;
  /** Subscribe to locally-discovered ICE candidates (trickle). */
  onLocalIce(cb: (candidate: CallIceCandidate) => void): () => void;
  /** Subscribe to ICE/DTLS connection-state changes. */
  onConnectionStateChange(cb: (state: 'connecting' | 'connected' | 'failed' | 'closed') => void): () => void;
  /**
   * Phase 5 — subscribe to per-track audio levels (RMS in [0, 1]) so
   * the in-call animal portraits can drive their mouth scale from the
   * actual audio. `local` is our mic, `remote` is the peer's playback.
   * Implementations should sample at roughly 12–20 Hz; below that the
   * mouth feels laggy, above that it costs CPU without visible gain.
   * Optional so non-WebRTC test peers don't have to implement it.
   */
  onAudioLevels?(cb: (levels: { local: number; remote: number }) => void): () => void;
  setMicMuted(muted: boolean): void;
  setSpeakerOn(on: boolean): void;
  close(): void;
}

/**
 * Factory signature so the orchestrator is independent of WebRTC.
 * `iceServers` carries STUN/TURN credentials fetched from
 * `GET /v1/turn/credentials` — short-lived, gated by Vouchflow auth.
 */
export interface CallPeerFactory {
  create(opts: {
    iceServers: IceServer[];
    /** Direction matters for some WebRTC SDP munging. */
    role: 'caller' | 'callee';
  }): Promise<CallPeer>;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
