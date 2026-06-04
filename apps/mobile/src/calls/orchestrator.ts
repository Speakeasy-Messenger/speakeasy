import {
  KNOWN_CALL_KINDS,
  newCallId,
  type CallAnswerPayload,
  type CallEndReason,
  type CallIcePayload,
  type CallKind,
  type CallOfferPayload,
  type WsClientMsg,
  type WsServerMsg,
} from '@speakeasy/shared';
import {
  decodeAnimationFrame,
  encodeAnimationFrame,
  isFresherSeq,
  type AnimationFrame,
} from './animation-channel.js';
import type { ApiClient } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';
import type { ensureSessionWithPeer as EnsureSessionFn } from '../crypto/session.js';
import { noteSessionEstablishedWith } from '../crypto/session.js';
import { b64ToBytes, bytesToB64, utf8FromBytes, utf8ToBytes } from '../utils/bytes.js';
import {
  ensureCameraPermission,
  ensureMicPermission,
} from '../permissions/runtime.js';
import { diag } from '../diag/log.js';
import type {
  ActiveCall,
  CallEndedReason,
  CallPeer,
  CallPeerFactory,
  CallStage,
  IceServer,
} from './types.js';
import { mediaKindForCall } from './types.js';
import { FilterError, setFilterBypass } from '../native/voice-filter.js';

/** Wall-clock ms before we give up on an unanswered ringing call. */
const RING_TIMEOUT_MS = 45_000;

/**
 * Frames the orchestrator emits — sent by the caller via the WS client.
 * Kept narrow on purpose: the orchestrator never reaches into the WS
 * client directly, so call logic is independently testable.
 */
type OutboundFrame = Extract<
  WsClientMsg,
  { type: 'call_offer' | 'call_answer' | 'call_ice' | 'call_end' }
>;

export interface CallOrchestratorDeps {
  myUserId: string;
  signalProtocol: SignalProtocolModule;
  api: ApiClient;
  peerFactory: CallPeerFactory;
  /** Function that fetches/refreshes a Vouchflow device token. */
  getDeviceToken: () => Promise<string>;
  /** Sends a frame on the authed WS. Caller is responsible for queueing. */
  send: (frame: OutboundFrame) => void;
  /** Same `ensureSessionWithPeer` ChatScreen uses — sets up the
   *  Signal session if missing so we can encrypt the call payload. */
  ensureSessionWithPeer: typeof EnsureSessionFn;
  /** Notify the UI store of state changes. Called on every transition. */
  onStateChange: (call: ActiveCall | undefined) => void;
  /**
   * Per SETTINGS.md §4.1 — when the user has flipped "Allow incoming
   * calls" off, the orchestrator auto-declines without surfacing a
   * ringing UI. Optional so tests don't have to inject it (treated
   * as "always allow" when undefined).
   */
  getAllowIncomingCalls?: () => boolean;
  /**
   * Called once a call has reached a terminal state. UI uses this to
   * record an entry in the local call history.
   */
  onCallFinished: (entry: CallHistoryEntry) => void;
  /**
   * Phase 5j Private Call — fired every time an `AnimationFrame`
   * arrives from the peer's data channel (already decoded). The UI
   * adapter pushes into `usePeerAnimation` to drive the peer avatar
   * Render. Optional so the test harness doesn't have to wire it.
   */
  onPeerAnimationFrame?: (peerUserId: string, frame: AnimationFrame) => void;
  /**
   * Phase 5j Private Call — voice filter install/dispose. The JS
   * shim at `apps/mobile/src/native/voice-filter.ts` is the
   * production implementation; tests inject a no-op stub so the
   * data-channel suite doesn't need the native module.
   *
   * `wrap(callId)` resolves when the DSP is installed and the next
   * captured frame will be filtered. Rejects with `FilterError` on
   * any failure (no native module, init error, immediate latency
   * trip) — the orchestrator catches this and ends the call via
   * `endWithFilterFailure` so the brand promise's failure-closed
   * posture holds.
   *
   * `dispose()` is best-effort; the orchestrator doesn't await it.
   */
  voiceFilter?: {
    wrap: (callId: string) => Promise<unknown>;
    dispose: () => Promise<void>;
  };
  /** Now provider — injected for tests. */
  now?: () => number;
  /** Setter so tests can inject a deterministic timeout. */
  ringTimeoutMs?: number;
}

export interface CallHistoryEntry {
  callId: string;
  peerUserId: string;
  isCaller: boolean;
  startedAt: number;
  endedAt: number;
  /** Connected-to-ended duration in seconds; 0 if call never connected. */
  durationSec: number;
  reason: CallEndedReason;
  /** User-facing call kind — the chat-history system bubble distinguishes
   *  "voice call · 0:42." / "video call · 0:42." / "private call · 0:42." */
  kind: CallKind;
}

/**
 * 1:1 voice call state machine.
 *
 * Crypto envelope: every `call_offer` / `call_answer` / `call_ice` payload
 * is JSON-serialized, then encrypted with the existing Signal session
 * to the peer (same module ChatScreen uses). The DTLS fingerprints
 * inside the SDP are therefore Signal-authenticated — a hostile TURN
 * relay cannot substitute its own fingerprints to MITM the media path.
 *
 * `call_end` carries no ciphertext; just a plaintext reason. Hanging
 * up doesn't leak content.
 */
export class CallOrchestrator {
  private active?: ActiveCall;
  private peer?: CallPeer;
  private ringTimer?: ReturnType<typeof setTimeout>;
  private localIceUnsub?: () => void;
  private connStateUnsub?: () => void;
  private animationFrameUnsub?: () => void;
  /** Latest accepted inbound animation-frame seq, for dedup + reorder rejection. */
  private latestAnimationSeq?: number;
  /** Monotonic counter the sender stamps on outbound animation frames. */
  private outboundAnimationSeq = 0;

  /**
   * Sequential queue for inbound call frames.
   *
   * When the WS reconnects and the server drains a buffered call_offer
   * + trailing ICE candidates, the message-router dispatches each
   * frame via `onCallFrame?.(frame)` without awaiting. This means
   * `handleIncomingIce` can run before `handleIncomingOffer` finishes
   * creating the peer + setting `this.active` — and the early-ICE
   * guard (`if (!this.active || ...)`) silently drops those candidates.
   *
   * The fix: enqueue every call frame and process them one at a time.
   * `handleFrame` pushes to the queue; the drain loop runs each
   * handler sequentially (awaiting the previous one before starting
   * the next). This guarantees the offer is fully processed before
   * any trailing ICE frames attempt to add candidates to the peer.
   */
  private callFrameQueue: WsServerMsg[] = [];
  private callFrameDraining = false;

  constructor(private readonly deps: CallOrchestratorDeps) {}

  getActive(): ActiveCall | undefined {
    return this.active;
  }

  /**
   * Local user dials `peerUserId`. Returns the new callId so the UI can
   * navigate to the CallScreen keyed off it. Defaults to audio; pass
   * `'video'` to negotiate a camera track via VideoCallScreen.
   */
  async startOutgoing(
    peerUserId: string,
    kind: CallKind = 'audio',
  ): Promise<string> {
    if (this.active) {
      throw new Error('busy: another call is already active');
    }
    if (peerUserId === this.deps.myUserId) {
      throw new Error('cannot call self');
    }
    const callId = newCallId();
    this.setActive({
      callId,
      peerUserId,
      isCaller: true,
      stage: 'outgoing_dialing',
      stageEnteredAt: this.now(),
      micMuted: false,
      // Video defaults to speaker (user is looking at the screen);
      // audio + private both default to earpiece (held to the ear).
      speakerOn: kind === 'video',
      kind,
    });
    diag('call', 'startOutgoing', { callId, peerUserId, kind });

    try {
      const iceServers = await this.fetchIceServers();
      diag('call', 'iceServers fetched', { count: iceServers.length });
      const peer = await this.deps.peerFactory.create({
        iceServers,
        role: 'caller',
        // 'private' → 'audio' at WebRTC layer (see mediaKindForCall).
        mediaKind: mediaKindForCall(kind),
      });
      diag('call', 'peer created');
      this.attachPeer(peer);
      // Phase 5j Private Call — open the animation data channel
      // BEFORE the offer so the SDP includes the channel's m-section.
      // Receiver discovers the channel via WebRTC's `ondatachannel`
      // event and subscribes through its own `onAnimationFrame`.
      // No-op for kind:'audio' / 'video' — those don't use it.
      if (kind === 'private') {
        peer.openAnimationDataChannel?.();
        // Install the voice filter BEFORE createOffer triggers the
        // peer's ensureLocalStream → getUserMedia → addTrack chain.
        // The DSP runs inside the native audio device path (forked
        // WebRtcAudioRecord on Android, SpeakeasyAudioDevice on iOS)
        // and starts filtering as soon as the next capture frame
        // arrives. wrapTrack returns the same track id back — the
        // filter wraps SAMPLES, not the track handle.
        await this.installFilterOrEndCall(callId);
      }
      const peerOffer = await peer.createOffer();
      const offer: CallOfferPayload = { ...peerOffer, kind };
      diag('call', 'offer created', { sdpLen: offer.sdp.length });
      // Plaintext `kind` hint on the WS frame lets the server fan out
      // only to peer devices whose capability set includes this kind
      // (see apps/api/src/ws/call-router.ts + connections.ts).
      await this.sendEncrypted(peerUserId, callId, 'call_offer', offer, kind);
      diag('call', 'offer sent', { peerUserId, callId });
      this.transition('outgoing_ringing');
      this.armRingTimeout();
      return callId;
    } catch (err) {
      diag('call', 'startOutgoing FAILED', { err: String(err) });
      this.endLocally('failed');
      throw err;
    }
  }

  /** User accepted an incoming call. Builds + sends the answer. */
  async accept(): Promise<void> {
    diag('call', 'accept: enter', {
      stage: this.active?.stage,
      callId: this.active?.callId,
      kind: this.active?.kind,
    });
    if (!this.active || this.active.stage !== 'incoming_ringing') {
      throw new Error(`cannot accept in stage=${this.active?.stage}`);
    }
    if (!this.peer) throw new Error('no peer attached');
    try {
      // Phase 5j Private Call — install the voice filter BEFORE
      // createAnswer triggers ensureLocalStream → getUserMedia →
      // addTrack on the callee side. Symmetric with startOutgoing on
      // the caller side; both endpoints filter their own mic.
      if (this.active.kind === 'private') {
        await this.installFilterOrEndCall(this.active.callId);
        if (!this.active) {
          // installFilterOrEndCall ended the call — bail before
          // createAnswer, the peer is already torn down.
          throw new Error('filter_failure during accept');
        }
      }
      const answer = await this.peer.createAnswer();
      await this.sendEncrypted(
        this.active.peerUserId,
        this.active.callId,
        'call_answer',
        answer,
      );
      this.transition('connecting');
      this.clearRingTimeout();
    } catch (err) {
      diag('call', 'accept FAILED', { err: String(err) });
      this.endLocally('failed');
      throw err;
    }
  }

  /** User declined an incoming call before answering. */
  decline(): void {
    if (!this.active || this.active.stage !== 'incoming_ringing') return;
    this.deps.send({
      type: 'call_end',
      to: this.active.peerUserId,
      call_id: this.active.callId,
      reason: 'decline',
    });
    this.endLocally('decline');
  }

  /** User hung up an active call, or cancelled a ringing one. */
  hangup(): void {
    if (!this.active) return;
    const wireReason: CallEndReason =
      this.active.stage === 'outgoing_dialing' ||
      this.active.stage === 'outgoing_ringing'
        ? 'cancel'
        : 'hangup';
    // Wrap the WS send so a non-authed socket (e.g. flapped mid-
    // ringing) doesn't throw out of hangup() and crash the screen.
    // The endLocally() teardown below MUST run regardless — local
    // cleanup is what frees the mic + audio session + UI state.
    // The server's auth-timeout will eventually drop the orphan.
    try {
      this.deps.send({
        type: 'call_end',
        to: this.active.peerUserId,
        call_id: this.active.callId,
        reason: wireReason,
      });
    } catch (err) {
      diag('call', 'hangup send failed (continuing local teardown)', {
        err: String(err),
      });
    }
    const localReason: CallEndedReason =
      wireReason === 'cancel' ? 'cancel' : 'completed';
    this.endLocally(localReason);
  }

  /**
   * Phase 5j Private Call — encode + ship one animation frame to the
   * peer over the data channel. Called by the audio-pipeline owner
   * (the native filter shim once it lands; for now wired by tests +
   * any future JS-side simulator). No-op if the peer doesn't support
   * data channels (covers MockPeer and older builds), if the channel
   * isn't open yet (frame is dropped — fresh-or-drop semantics), or
   * if there's no active call. Returns the seq it assigned (mod 2^16)
   * so the caller can correlate dropped frames if they care.
   */
  sendAnimationFrame(frame: Omit<AnimationFrame, 'seq'>): number {
    if (!this.active || !this.peer?.sendAnimationFrame) return -1;
    this.outboundAnimationSeq = (this.outboundAnimationSeq + 1) & 0xffff;
    const encoded = encodeAnimationFrame({
      ...frame,
      seq: this.outboundAnimationSeq,
    });
    try {
      this.peer.sendAnimationFrame(encoded);
    } catch (err) {
      // Channel closed mid-send (call ending) — drop the frame.
      diag('call', 'sendAnimationFrame failed', { err: String(err) });
    }
    return this.outboundAnimationSeq;
  }

  /**
   * Brand-promise failure-closed teardown for Private Call. Called by
   * the native filter shim when initialization fails, the model load
   * crashes, the latency soft-fail threshold trips, or any other
   * runtime issue would leave the local mic exposed. Sends
   * `filter_failure` on the wire (the peer's orchestrator maps this
   * to `peer_filter_failure` locally) and tears down the call with
   * the matching local reason so the inline failure UI on CallScreen
   * renders the correct copy.
   *
   * The plan's "Mid-call fallback policy" (Constraints section): no
   * silent fall-back to plain audio. Calling `endLocally('hangup')`
   * here would leak the user-believes-masked / actually-isn't gap
   * the whole feature was designed to prevent.
   */
  endWithFilterFailure(): void {
    if (!this.active) return;
    try {
      this.deps.send({
        type: 'call_end',
        to: this.active.peerUserId,
        call_id: this.active.callId,
        reason: 'filter_failure',
      });
    } catch (err) {
      diag('call', 'filter_failure send failed (continuing local teardown)', {
        err: String(err),
      });
    }
    this.endLocally('filter_failure');
  }

  /**
   * Install the voice filter via `wrapTrackWithFilter` (the JS shim
   * over the Android/iOS native module). On `FilterError`, call
   * `endWithFilterFailure` to tear the call down and surface
   * `filter_failure` on the wire so the peer renders the right
   * inline message. Used by `startOutgoing` (kind:'private') and
   * `accept` (this.active.kind:'private').
   *
   * The track-id argument is opaque to the filter: both native
   * impls install the DSP into a process-wide holder and return
   * the same id back (the filter wraps SAMPLES, not the track).
   * We pass the call id as a label so diag logs can correlate.
   */
  private async installFilterOrEndCall(callId: string): Promise<void> {
    // `voiceFilter` is optional on deps so tests of the data-channel
    // / state-machine paths don't have to wire it. When absent we
    // treat the install as a no-op success — the brand-promise
    // failure-closed gate happens at services.ts wiring time
    // (production deps always include the real wrap).
    const filter = this.deps.voiceFilter;
    if (!filter) {
      diag('call', 'voice filter dep absent — skipping install', { callId });
      return;
    }
    try {
      await filter.wrap(callId);
      diag('call', 'voice filter installed', { callId });
    } catch (err) {
      if (err instanceof FilterError) {
        diag('call', 'voice filter install FAILED', {
          callId,
          code: err.code,
        });
      } else {
        diag('call', 'voice filter install threw non-FilterError', {
          callId,
          err: String(err),
        });
      }
      this.endWithFilterFailure();
    }
  }

  setMicMuted(muted: boolean): void {
    if (!this.active) return;
    this.peer?.setMicMuted(muted);
    this.setActive({ ...this.active, micMuted: muted });
  }

  setSpeakerOn(on: boolean): void {
    if (!this.active) return;
    this.peer?.setSpeakerOn(on);
    this.setActive({ ...this.active, speakerOn: on });
  }

  /**
   * Live mask on/off for a masked ('private') call (#13). `bypassed=true`
   * reveals the user's REAL voice to the peer; `false` re-masks. Returns
   * true only if the native filter actually honored the flip — on an
   * older native binary without `setBypass` we return false and leave the
   * mask ON, so we never silently leak the real voice. No-op (false) for
   * non-masked calls. The reveal is SILENT to the peer (no signal frame).
   */
  async setMaskBypassed(bypassed: boolean): Promise<boolean> {
    if (!this.active || this.active.kind !== 'private') return false;
    const applied = await setFilterBypass(bypassed);
    if (!applied) return false;
    this.setActive({ ...this.active, maskBypassed: bypassed });
    return true;
  }

  /**
   * Subscribe to per-tick audio levels — `local` = our mic, `remote` =
   * peer playback, both in [0, 1]. Returns a no-op unsubscribe when
   * the active peer doesn't implement audio-level polling (e.g. the
   * in-memory test peer in orchestrator.test.ts) so callers can
   * always `useEffect`-attach without a capability check.
   *
   * Re-subscribes are not auto-routed across peer churn — the
   * CallScreen mounts after the peer is attached and unmounts before
   * close, so a single subscribe-on-mount is sufficient.
   */
  onAudioLevels(
    cb: (levels: { local: number; remote: number }) => void,
  ): () => void {
    return this.peer?.onAudioLevels?.(cb) ?? (() => {});
  }

  /**
   * Video-call helpers — pass through to the active peer. Audio peers
   * return undefined / no-op subscriptions so VideoCallScreen can call
   * these unconditionally without checking the call kind.
   */
  getLocalStreamURL(): string | undefined {
    return this.peer?.getLocalStreamURL?.();
  }
  onRemoteStreamURL(cb: (url: string | undefined) => void): () => void {
    return this.peer?.onRemoteStreamURL?.(cb) ?? (() => {});
  }
  async flipCamera(): Promise<void> {
    await this.peer?.flipCamera?.();
  }

  /**
   * Inbound frame router. Wired into `makeMessageRouter`. Only acts on
   * `call_*` frames; everything else is ignored.
   *
   * Frames are **enqueued** and processed sequentially to prevent the
   * ICE-during-offer-setup race documented on `callFrameQueue`.
   * Non-call frames pass through immediately.
   */
  async handleFrame(frame: WsServerMsg): Promise<void> {
    const isCallFrame =
      frame.type === 'call_offer' ||
      frame.type === 'call_answer' ||
      frame.type === 'call_ice' ||
      frame.type === 'call_end';

    if (!isCallFrame) return;

    diag('call', `handleFrame: ${frame.type}`, {
      from: frame.from,
      call_id: frame.call_id,
    });
    this.callFrameQueue.push(frame);
    await this.drainCallFrameQueue();
  }

  /** Process queued call frames one at a time, awaiting each handler. */
  private async drainCallFrameQueue(): Promise<void> {
    if (this.callFrameDraining) return;
    this.callFrameDraining = true;
    try {
      while (this.callFrameQueue.length > 0) {
        const frame = this.callFrameQueue.shift()!;
        switch (frame.type) {
          case 'call_offer':
            await this.handleIncomingOffer(frame.from, frame.call_id, frame.ciphertext);
            break;
          case 'call_answer':
            await this.handleIncomingAnswer(frame.from, frame.call_id, frame.ciphertext);
            break;
          case 'call_ice':
            await this.handleIncomingIce(frame.from, frame.call_id, frame.ciphertext);
            break;
          case 'call_end':
            this.handleIncomingEnd(frame.from, frame.call_id, frame.reason);
            break;
        }
      }
    } finally {
      this.callFrameDraining = false;
    }
  }

  // -------- inbound handlers --------

  private async handleIncomingOffer(
    fromUserId: string,
    callId: string,
    ciphertextB64: string,
  ): Promise<void> {
    if (this.active) {
      // Already on a call — tell the caller we're busy. Don't transition.
      this.deps.send({
        type: 'call_end',
        to: fromUserId,
        call_id: callId,
        reason: 'busy',
      });
      diag('call', 'incoming offer rejected: busy', { fromUserId, callId });
      return;
    }
    // SETTINGS.md §4.1: "Allow incoming calls" toggle. When off,
    // we auto-decline with `decline` and never surface a ringing
    // UI. Same wire-level behavior as the user tapping Decline,
    // so the caller's side rings out naturally.
    if (this.deps.getAllowIncomingCalls?.() === false) {
      this.deps.send({
        type: 'call_end',
        to: fromUserId,
        call_id: callId,
        reason: 'decline',
      });
      diag('call', 'incoming offer auto-declined (toggle off)', {
        fromUserId,
        callId,
      });
      return;
    }
    try {
      const payload = (await this.decrypt(fromUserId, ciphertextB64)) as CallOfferPayload;
      // Resolve + validate the call kind. Absent ⇒ 'audio' (back-compat
      // with pre-rc.34 clients that never set the field). Unknown ⇒
      // silently abort: the brand promise hole this closes is a future
      // unknown-kind sender (e.g., 'private' before rc.130) reaching an
      // old client and being coerced to 'audio' (raw voice on the wire
      // when the sender thinks they're masked). Codex tension #1 from
      // /plan-eng-review. Caller will see no answer + drop on its 45s
      // ring timeout — same outcome as an offline peer.
      const rawKind = payload.kind;
      let kind: CallKind;
      if (rawKind === undefined) {
        kind = 'audio';
      } else if (KNOWN_CALL_KINDS.has(rawKind as CallKind)) {
        kind = rawKind as CallKind;
      } else {
        diag('call', 'incoming offer rejected: unknown_call_kind', {
          fromUserId,
          callId,
          kind: rawKind,
        });
        return;
      }
      diag('call', 'handleIncomingOffer: decrypted', {
        fromUserId,
        callId,
        kind,
      });
      const iceServers = await this.fetchIceServers();
      const peer = await this.deps.peerFactory.create({
        iceServers,
        role: 'callee',
        // 'private' maps to 'audio' at the WebRTC layer — the filter
        // wraps the local mic track before it hits the encoder, but
        // peerConnection still negotiates audio-only media.
        mediaKind: mediaKindForCall(kind),
      });
      this.attachPeer(peer);
      await peer.setRemoteOffer(payload);
      this.setActive({
        callId,
        peerUserId: fromUserId,
        isCaller: false,
        stage: 'incoming_ringing',
        stageEnteredAt: this.now(),
        micMuted: false,
        speakerOn: kind === 'video',
        kind,
      });
      diag('call', 'handleIncomingOffer: ringing', {
        fromUserId,
        callId,
        kind,
      });
      this.armRingTimeout();
      // rc.55: warm up the OS permission prompts in parallel with the
      // ringing UI. Without this, the prompts fire inside `gUM` only
      // after the user taps Accept — and on a permission-cold device
      // tapping through Allow takes 5–15s, during which the caller's
      // PC sits in have-local-offer with no answer and (commonly)
      // they hang up. Fire-and-forget: ensureMicPermission is
      // idempotent, so a redundant prompt from a later gUM call is
      // a no-op. ICE / SDP setup is already done above so this
      // doesn't gate any wire-side work.
      void this.warmUpPermissions(kind);
    } catch (err) {
      diag('call', 'incoming offer FAILED', {
        fromUserId,
        callId,
        err: String(err),
      });
      this.deps.send({
        type: 'call_end',
        to: fromUserId,
        call_id: callId,
        reason: 'hangup',
      });
    }
  }

  private async handleIncomingAnswer(
    fromUserId: string,
    callId: string,
    ciphertextB64: string,
  ): Promise<void> {
    if (
      !this.active ||
      this.active.callId !== callId ||
      this.active.peerUserId !== fromUserId ||
      !this.peer
    ) {
      return;
    }
    try {
      const payload = (await this.decrypt(fromUserId, ciphertextB64)) as CallAnswerPayload;
      await this.peer.setRemoteAnswer(payload);
      this.transition('connecting');
      this.clearRingTimeout();
    } catch (err) {
      diag('call', 'incoming answer FAILED', { err: String(err) });
      this.endLocally('failed');
    }
  }

  private async handleIncomingIce(
    fromUserId: string,
    callId: string,
    ciphertextB64: string,
  ): Promise<void> {
    if (!this.active || this.active.callId !== callId || !this.peer) return;
    try {
      const payload = (await this.decrypt(fromUserId, ciphertextB64)) as CallIcePayload;
      await this.peer.addRemoteIce(payload);
    } catch (err) {
      diag('call', 'incoming ice FAILED', { err: String(err) });
    }
  }

  private handleIncomingEnd(
    fromUserId: string,
    callId: string,
    reason: CallEndReason,
  ): void {
    if (!this.active || this.active.callId !== callId || this.active.peerUserId !== fromUserId) {
      return;
    }
    // Wire reason is the SENDER's POV. `filter_failure` over the wire
    // means "the OTHER party's filter died" from my perspective — the
    // local stored reason becomes `peer_filter_failure` so the inline
    // failure UI shows the right copy ("ended due to a technical issue
    // on the other end") instead of the local-failed copy. Wire
    // `peer_filter_failure` should never arrive from a peer (they'd
    // only ever observe their own filter dying as `filter_failure`),
    // but if it does, treat it as a malformed-frame no-op.
    let local: CallEndedReason;
    switch (reason) {
      case 'cancel':
        local = 'no_answer';
        break;
      case 'decline':
        local = 'decline';
        break;
      case 'busy':
        local = 'busy';
        break;
      case 'filter_failure':
        local = 'peer_filter_failure';
        break;
      case 'peer_filter_failure':
        // Malformed: a peer shouldn't claim this. Fall through to
        // generic hangup so the UI doesn't get stuck.
        local = 'hangup';
        break;
      default:
        local = this.active.stage === 'connected' ? 'completed' : 'hangup';
    }
    this.endLocally(local);
  }

  // -------- helpers --------

  private attachPeer(peer: CallPeer): void {
    this.peer = peer;
    this.localIceUnsub = peer.onLocalIce((candidate) => {
      void (async () => {
        if (!this.active) return;
        try {
          await this.sendEncrypted(
            this.active.peerUserId,
            this.active.callId,
            'call_ice',
            { v: 1, candidates: [candidate] } satisfies CallIcePayload,
          );
        } catch (err) {
          diag('call', 'local ice send FAILED', { err: String(err) });
        }
      })();
    });
    this.connStateUnsub = peer.onConnectionStateChange((state) => {
      if (!this.active) return;
      // rc.50: log the call's stage when WebRTC fires a state change
      // so the next "call dropped before I could answer" report has
      // actionable data. The video-call-during-ringing-closes-on-its-
      // own bug from tester2 had no diag explaining why — only that
      // connectionstate went straight to 'closed' without 'connecting'
      // or 'failed' first.
      diag('call', 'peer connectionStateChange', {
        peerState: state,
        callStage: this.active.stage,
        kind: this.active.kind,
        callId: this.active.callId,
      });
      if (state === 'connected') {
        this.transition('connected', { connectedAt: this.now() });
      } else if (state === 'failed') {
        this.endLocally('failed');
      } else if (state === 'closed') {
        // Closed without a wire-side end — treat as completed if we
        // were connected, hangup otherwise.
        const local: CallEndedReason =
          this.active.stage === 'connected' ? 'completed' : 'hangup';
        this.endLocally(local);
      }
    });
    // Phase 5j Private Call — subscribe to inbound animation frames.
    // Hooked on every peer (not just kind:'private') so the callee
    // sees frames as soon as the caller opens the channel; voice and
    // video calls simply never receive any. Filter at decode time
    // (decodeAnimationFrame returns undefined for malformed/wrong-
    // version frames, which a non-Private peer would never send).
    this.animationFrameUnsub = peer.onAnimationFrame?.((payload) => {
      const frame = decodeAnimationFrame(payload);
      if (!frame) return;
      if (!isFresherSeq(this.latestAnimationSeq, frame.seq)) return;
      this.latestAnimationSeq = frame.seq;
      if (!this.active) return;
      this.deps.onPeerAnimationFrame?.(this.active.peerUserId, frame);
    });
  }

  private async sendEncrypted(
    peerUserId: string,
    callId: string,
    type: 'call_offer' | 'call_answer' | 'call_ice',
    payload: CallOfferPayload | CallAnswerPayload | CallIcePayload,
    /**
     * Only set on `call_offer` — the plaintext `kind` hint the server
     * reads to fan out to capable peer devices only. Encrypted SDP
     * carries the same value inside `payload.kind` for the receiver.
     */
    offerKind?: CallKind,
  ): Promise<void> {
    diag('call', 'sendEncrypted: enter', { type, peerUserId, callId });
    const deviceToken = await this.deps.getDeviceToken();
    await this.deps.ensureSessionWithPeer({
      api: this.deps.api,
      signalProtocol: this.deps.signalProtocol,
      deviceToken,
      peerUserId,
    });
    diag('call', 'sendEncrypted: session ensured', { type, peerUserId });
    const plaintext = utf8ToBytes(JSON.stringify(payload));
    const ciphertext = await this.deps.signalProtocol.encrypt(peerUserId, plaintext);
    diag('call', 'sendEncrypted: ciphertext built', {
      type,
      peerUserId,
      ctLen: ciphertext.length,
    });
    if (type === 'call_offer') {
      this.deps.send({
        type,
        to: peerUserId,
        call_id: callId,
        ciphertext: bytesToB64(ciphertext),
        ...(offerKind && { kind: offerKind }),
      });
    } else {
      this.deps.send({
        type,
        to: peerUserId,
        call_id: callId,
        ciphertext: bytesToB64(ciphertext),
      });
    }
    diag('call', 'sendEncrypted: ws.send returned', { type, peerUserId, callId });
  }

  private async decrypt(fromUserId: string, ciphertextB64: string): Promise<unknown> {
    const ciphertext = b64ToBytes(ciphertextB64);
    const plaintext = await this.deps.signalProtocol.decrypt(fromUserId, ciphertext);
    // rc.58: decrypt succeeded → libsignal has an established session
    // for this peer. Mark in the process-lifetime cache so the next
    // sendEncrypted to them (call_answer, call_ice, etc.) skips the
    // destructive ensureSessionWithPeer re-initiation. Without this,
    // a cold-started callee would burn a fresh OTPK on every reply
    // and produce a PreKey-style ciphertext the caller can't decrypt
    // ("invalid PreKey message" — actual user-reported bug).
    noteSessionEstablishedWith(fromUserId);
    return JSON.parse(utf8FromBytes(plaintext));
  }

  private async fetchIceServers(): Promise<IceServer[]> {
    try {
      const deviceToken = await this.deps.getDeviceToken();
      return await this.deps.api.fetchTurnCredentials(deviceToken);
    } catch (err) {
      diag('call', 'fetchTurnCredentials FAILED — using STUN-only', {
        err: String(err),
      });
      // Fall back to public STUN. Direct P2P will work for ~70-80% of
      // mobile-to-mobile calls; relayed ones will fail. The orchestrator
      // surfaces that as a `failed` end-state via the connection-state
      // listener, not a silent hang.
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  }

  /**
   * rc.55: prompt for mic (and camera, if video) permissions while
   * the IncomingCallScreen is up. iOS no-ops these (system handles
   * via Info.plist). On Android, the OS dialog overlays the call
   * screen and the user grants while the call is still ringing —
   * by the time they tap Accept, gUM is instant. Without this,
   * permissions fired inside `accept() → createAnswer() → gUM` and
   * the 5–15s of dialog tapping pushed the caller past their PC's
   * answer-window. Idempotent — a second call to ensureMicPermission
   * after the user has decided is a no-op.
   */
  private async warmUpPermissions(kind: CallKind): Promise<void> {
    try {
      const mic = await ensureMicPermission();
      diag('call', 'warmup mic', { result: mic });
      if (kind === 'video') {
        const cam = await ensureCameraPermission();
        diag('call', 'warmup camera', { result: cam });
      }
    } catch (err) {
      diag('call', 'warmup permissions threw (continuing)', {
        err: String(err),
      });
    }
  }

  private setActive(call: ActiveCall): void {
    this.active = call;
    this.deps.onStateChange(call);
  }

  private transition(stage: CallStage, patch: Partial<ActiveCall> = {}): void {
    if (!this.active) return;
    this.setActive({
      ...this.active,
      ...patch,
      stage,
      stageEnteredAt: this.now(),
    });
  }

  private endLocally(reason: CallEndedReason): void {
    if (!this.active) return;
    const startedAt = this.active.stageEnteredAt; // first stage's timestamp
    const connectedAt = this.active.connectedAt;
    const endedAt = this.now();
    const ended: ActiveCall = {
      ...this.active,
      stage: 'ended',
      endedReason: reason,
      stageEnteredAt: endedAt,
    };
    this.setActive(ended);
    this.deps.onCallFinished({
      callId: ended.callId,
      peerUserId: ended.peerUserId,
      isCaller: ended.isCaller,
      startedAt,
      endedAt,
      durationSec: connectedAt ? Math.round((endedAt - connectedAt) / 1000) : 0,
      reason,
      kind: ended.kind,
    });
    this.cleanup();
    // Clear `active` after onStateChange has seen the `ended` snapshot
    // so the UI can render "Call ended" briefly before the screen
    // dismisses itself.
    this.active = undefined;
    this.deps.onStateChange(undefined);
  }

  private cleanup(): void {
    this.clearRingTimeout();
    this.localIceUnsub?.();
    this.connStateUnsub?.();
    this.animationFrameUnsub?.();
    this.localIceUnsub = undefined;
    this.connStateUnsub = undefined;
    this.animationFrameUnsub = undefined;
    this.latestAnimationSeq = undefined;
    this.outboundAnimationSeq = 0;
    this.peer?.close();
    this.peer = undefined;
    // Phase 5j Private Call — clear the process-wide filter holder
    // so the next captured frame after teardown is unfiltered (and
    // the next call doesn't accidentally inherit a stale filter
    // from a previous Private Call). Best-effort: dispose swallows
    // its own errors; we don't gate cleanup on it.
    void this.deps.voiceFilter?.dispose();
  }

  private armRingTimeout(): void {
    this.clearRingTimeout();
    const ms = this.deps.ringTimeoutMs ?? RING_TIMEOUT_MS;
    this.ringTimer = setTimeout(() => {
      if (
        this.active &&
        (this.active.stage === 'outgoing_dialing' ||
          this.active.stage === 'outgoing_ringing' ||
          this.active.stage === 'incoming_ringing')
      ) {
        // For outgoing: caller's local timeout — record as no_answer +
        // tell the peer to stop ringing. For incoming: callee's local
        // timeout (user didn't pick up) — the caller will see their
        // own timeout independently; no need to send anything.
        if (this.active.isCaller) {
          this.deps.send({
            type: 'call_end',
            to: this.active.peerUserId,
            call_id: this.active.callId,
            reason: 'cancel',
          });
        }
        this.endLocally('no_answer');
      }
    }, ms);
  }

  private clearRingTimeout(): void {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = undefined;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
