import type {
  CallAnswerPayload,
  CallEndReason,
  CallIceCandidate,
  CallIcePayload,
  CallKind,
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

/**
 * What WebRTC's PeerConnection negotiates. 'private' is conspicuously
 * absent here: Private Call IS an audio peer connection from WebRTC's
 * perspective — the voice filter modifies the local audio track BEFORE
 * it reaches the encoder, but the negotiated media kind is still audio.
 * Use `mediaKindForCall(CallKind)` to map a user-facing call kind down
 * to the WebRTC concept.
 */
export type CallMediaKind = 'audio' | 'video';

/** Map a user-facing call kind to what WebRTC negotiates. */
export function mediaKindForCall(kind: CallKind): CallMediaKind {
  return kind === 'video' ? 'video' : 'audio';
}

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
  /**
   * Masked ('private') calls only (#13): true when the user has REVEALED
   * their real voice (the filter is bypassed). Default/undefined = masked.
   * Drives the in-call mask status chip. The reveal is silent to the peer.
   */
  maskBypassed?: boolean;
  /** Speakerphone routing toggle (vs earpiece). */
  speakerOn: boolean;
  /**
   * User-facing call kind. 'audio'/'video' are the historical defaults;
   * 'private' (Phase 5j) renders the peer's animated animal with a
   * voice-filtered audio stream. Set at startOutgoing time on the
   * caller, and at handleIncomingOffer time on the callee from the
   * offer payload's `kind` field.
   */
  kind: CallKind;
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
  /**
   * Video-only — return the local MediaStream URL (used by RTCView
   * `streamURL`) when the call has a video track. Audio-only peers
   * return undefined. Optional so test peers don't have to implement
   * it. Returns the stream's toURL() result.
   */
  getLocalStreamURL?(): string | undefined;
  /**
   * Video-only — subscribe to the remote MediaStream URL once it
   * arrives. Fired on the `track` event with kind=video. Returns an
   * unsubscribe function.
   */
  onRemoteStreamURL?(cb: (url: string | undefined) => void): () => void;
  /**
   * Video-only — flip between front-facing (user) and rear (environment)
   * camera. No-op for audio peers.
   */
  flipCamera?(): Promise<void>;
  /**
   * Phase 5j Private Call — open the unreliable, unordered side
   * channel for the sender's per-frame `AnimationFrame` broadcast at
   * 30 Hz. Settings locked to `{ ordered: false, maxRetransmits: 0 }`
   * so a network blip drops one frame (brief mouth idle), NOT 200 ms
   * of stale lip-sync. Caller calls this when both sides confirm
   * `kind:'private'`; the receiver's underlying WebRTC fires its own
   * `ondatachannel` event so the same `onAnimationFrame` subscription
   * works on both sides.
   *
   * Optional because: existing audio/video calls don't use it, test
   * peers can no-op this, and a peer impl that doesn't support data
   * channels degrades gracefully to "no peer animation" rather than
   * crashing the call.
   */
  openAnimationDataChannel?(): void;
  /** Subscribe to incoming raw animation frame payloads — caller
   *  passes each through `decodeAnimationFrame`. */
  onAnimationFrame?(cb: (payload: Uint8Array) => void): () => void;
  /** Send an animation frame to the peer. No-op if the channel
   *  isn't open yet (channels can take ~100 ms to negotiate; dropping
   *  the first few frames costs at most a brief mouth idle). */
  sendAnimationFrame?(payload: Uint8Array): void;
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
    /**
     * Audio default. When 'video' the peer requests camera + mic from
     * `getUserMedia` and adds both tracks; the orchestrator routes the
     * remote stream URL into the VideoCallScreen.
     */
    mediaKind?: CallMediaKind;
  }): Promise<CallPeer>;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
