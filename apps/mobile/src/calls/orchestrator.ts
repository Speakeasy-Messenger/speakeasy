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
import { b64ToBytes, bytesToB64, utf8FromBytes, utf8ToBytes } from '../utils/bytes.js';
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

  constructor(private readonly deps: CallOrchestratorDeps) {}

  getActive(): ActiveCall | undefined {
    return this.active;
  }

  /**
   * Local user dials `peerUserId`. Returns the new callId so the UI can
   * navigate to the CallScreen keyed off it.
   */
  async startOutgoing(peerUserId: string): Promise<string> {
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
      speakerOn: false,
    });
    diag('call', 'startOutgoing', { callId, peerUserId });

    try {
      const iceServers = await this.fetchIceServers();
      const peer = await this.deps.peerFactory.create({
        iceServers,
        role: 'caller',
      });
      this.attachPeer(peer);
      const offer = await peer.createOffer();
      await this.sendEncrypted(peerUserId, callId, 'call_offer', offer);
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
    this.deps.send({
      type: 'call_end',
      to: this.active.peerUserId,
      call_id: this.active.callId,
      reason: wireReason,
    });
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
   * Inbound frame router. Wired into `makeMessageRouter`. Only acts on
   * `call_*` frames; everything else is ignored.
   */
  async handleFrame(frame: WsServerMsg): Promise<void> {
    switch (frame.type) {
      case 'call_offer':
        return this.handleIncomingOffer(frame.from, frame.call_id, frame.ciphertext);
      case 'call_answer':
        return this.handleIncomingAnswer(frame.from, frame.call_id, frame.ciphertext);
      case 'call_ice':
        return this.handleIncomingIce(frame.from, frame.call_id, frame.ciphertext);
      case 'call_end':
        return this.handleIncomingEnd(frame.from, frame.call_id, frame.reason);
      default:
        return;
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
    try {
      const payload = (await this.decrypt(fromUserId, ciphertextB64)) as CallOfferPayload;
      const iceServers = await this.fetchIceServers();
      const peer = await this.deps.peerFactory.create({ iceServers, role: 'callee' });
      this.attachPeer(peer);
      await peer.setRemoteOffer(payload);
      this.setActive({
        callId,
        peerUserId: fromUserId,
        isCaller: false,
        stage: 'incoming_ringing',
        stageEnteredAt: this.now(),
        micMuted: false,
        speakerOn: false,
      });
      this.armRingTimeout();
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
    const deviceToken = await this.deps.getDeviceToken();
    await this.deps.ensureSessionWithPeer({
      api: this.deps.api,
      signalProtocol: this.deps.signalProtocol,
      deviceToken,
      peerUserId,
    });
    const plaintext = utf8ToBytes(JSON.stringify(payload));
    const ciphertext = await this.deps.signalProtocol.encrypt(peerUserId, plaintext);
    this.deps.send({
      type,
      to: peerUserId,
      call_id: callId,
      ciphertext: bytesToB64(ciphertext),
    });
  }

  private async decrypt(fromUserId: string, ciphertextB64: string): Promise<unknown> {
    const ciphertext = b64ToBytes(ciphertextB64);
    const plaintext = await this.deps.signalProtocol.decrypt(fromUserId, ciphertext);
    return JSON.parse(utf8FromBytes(plaintext));
  }

  private async fetchIceServers(): Promise<IceServer[]> {
    try {
      return await this.deps.api.fetchTurnCredentials();
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
