import {
  newCallId,
  type CallAnswerPayload,
  type CallEndReason,
  type CallIcePayload,
  type CallOfferPayload,
  type WsClientMsg,
  type WsServerMsg,
} from '@speakeasy/shared';
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
  /** Audio or video — the chat-history system bubble distinguishes
   *  "voice call · 0:42." from "video call · 0:42." */
  kind: 'audio' | 'video';
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
    kind: 'audio' | 'video' = 'audio',
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
      // Video calls default to speaker on — earpiece doesn't make sense
      // when the user is looking at the screen. Audio stays on earpiece.
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
        mediaKind: kind,
      });
      diag('call', 'peer created');
      this.attachPeer(peer);
      const peerOffer = await peer.createOffer();
      const offer: CallOfferPayload = { ...peerOffer, kind };
      diag('call', 'offer created', { sdpLen: offer.sdp.length });
      await this.sendEncrypted(peerUserId, callId, 'call_offer', offer);
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
    if (!this.active || this.active.stage !== 'incoming_ringing') {
      throw new Error(`cannot accept in stage=${this.active?.stage}`);
    }
    if (!this.peer) throw new Error('no peer attached');
    try {
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
      const kind = payload.kind ?? 'audio';
      diag('call', 'handleIncomingOffer: decrypted', {
        fromUserId,
        callId,
        kind,
      });
      const iceServers = await this.fetchIceServers();
      const peer = await this.deps.peerFactory.create({
        iceServers,
        role: 'callee',
        mediaKind: kind,
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
    const local: CallEndedReason =
      reason === 'cancel'
        ? 'no_answer'
        : reason === 'decline'
          ? 'decline'
          : reason === 'busy'
            ? 'busy'
            : this.active.stage === 'connected'
              ? 'completed'
              : 'hangup';
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
  }

  private async sendEncrypted(
    peerUserId: string,
    callId: string,
    type: 'call_offer' | 'call_answer' | 'call_ice',
    payload: CallOfferPayload | CallAnswerPayload | CallIcePayload,
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
    this.deps.send({
      type,
      to: peerUserId,
      call_id: callId,
      ciphertext: bytesToB64(ciphertext),
    });
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
  private async warmUpPermissions(kind: 'audio' | 'video'): Promise<void> {
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
    this.localIceUnsub = undefined;
    this.connStateUnsub = undefined;
    this.peer?.close();
    this.peer = undefined;
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
