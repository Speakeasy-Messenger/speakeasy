import { describe, expect, it, vi } from 'vitest';
import type {
  CallAnswerPayload,
  CallIceCandidate,
  CallIcePayload,
  CallOfferPayload,
  WsClientMsg,
  WsServerMsg,
} from '@speakeasy/shared';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import { CallOrchestrator } from './orchestrator.js';
import type { CallPeer, CallPeerFactory } from './types.js';

class MockPeer implements CallPeer {
  private iceListeners = new Set<(c: CallIceCandidate) => void>();
  private connListeners = new Set<(s: 'connecting' | 'connected' | 'failed' | 'closed') => void>();
  private animationListeners = new Set<(payload: Uint8Array) => void>();
  micMuted = false;
  speakerOn = false;
  closed = false;
  animationChannelOpen = false;
  sentAnimationFrames: Uint8Array[] = [];
  constructor(public readonly role: 'caller' | 'callee') {}

  async createOffer(): Promise<CallOfferPayload> {
    return { v: 1, sdp: `offer-from-${this.role}`, candidates: [] };
  }
  async setRemoteOffer(): Promise<void> {}
  async createAnswer(): Promise<CallAnswerPayload> {
    return { v: 1, sdp: `answer-from-${this.role}`, candidates: [] };
  }
  async setRemoteAnswer(): Promise<void> {}
  async addRemoteIce(_p: CallIcePayload): Promise<void> {}
  onLocalIce(cb: (c: CallIceCandidate) => void): () => void {
    this.iceListeners.add(cb);
    return () => this.iceListeners.delete(cb);
  }
  onConnectionStateChange(
    cb: (s: 'connecting' | 'connected' | 'failed' | 'closed') => void,
  ): () => void {
    this.connListeners.add(cb);
    return () => this.connListeners.delete(cb);
  }
  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
  }
  setSpeakerOn(on: boolean): void {
    this.speakerOn = on;
  }
  close(): void {
    this.closed = true;
  }
  emitConnState(s: 'connecting' | 'connected' | 'failed' | 'closed'): void {
    for (const c of this.connListeners) c(s);
  }
  openAnimationDataChannel(): void {
    this.animationChannelOpen = true;
  }
  onAnimationFrame(cb: (payload: Uint8Array) => void): () => void {
    this.animationListeners.add(cb);
    return () => this.animationListeners.delete(cb);
  }
  sendAnimationFrame(payload: Uint8Array): void {
    if (!this.animationChannelOpen) return;
    this.sentAnimationFrames.push(payload);
  }
  /** Simulate an inbound frame arriving from the wire. */
  emitAnimationFrame(payload: Uint8Array): void {
    for (const cb of this.animationListeners) cb(payload);
  }
}

interface OrchHarness {
  caller: CallOrchestrator;
  callee: CallOrchestrator;
  callerPeer(): MockPeer;
  calleePeer(): MockPeer;
  callerOut: WsClientMsg[];
  calleeOut: WsClientMsg[];
  /** Drain queued outbound frames in order, dispatching each to the
   *  opposite orchestrator. Returns when both queues are empty. */
  pump(): Promise<void>;
  finishedCaller: any[];
  finishedCallee: any[];
}

function makeOrchHarness(
  opts: {
    ringTimeoutMs?: number;
    /** Phase 5j Private Call — wired into both orchestrators when
     *  set, so tests of the animation-frame round-trip can see
     *  decoded inbound frames. */
    onPeerAnimationFrame?: (peerUserId: string, frame: any) => void;
  } = {},
): OrchHarness {
  const callerOut: WsClientMsg[] = [];
  const calleeOut: WsClientMsg[] = [];
  const finishedCaller: any[] = [];
  const finishedCallee: any[] = [];

  let callerPeerInstance: MockPeer | undefined;
  let calleePeerInstance: MockPeer | undefined;
  const callerFactory: CallPeerFactory = {
    async create() {
      callerPeerInstance = new MockPeer('caller');
      return callerPeerInstance;
    },
  };
  const calleeFactory: CallPeerFactory = {
    async create() {
      calleePeerInstance = new MockPeer('callee');
      return calleePeerInstance;
    },
  };

  const caller = new CallOrchestrator({
    myUserId: 'alice',
    signalProtocol: new MockSignalProtocolClient(),
    api: { fetchTurnCredentials: vi.fn(async () => []) } as any,
    peerFactory: callerFactory,
    getDeviceToken: async () => 'dvt_alice',
    send: (frame) => callerOut.push(frame),
    ensureSessionWithPeer: (async () => {}) as any,
    onStateChange: () => {},
    onCallFinished: (e) => finishedCaller.push(e),
    onPeerAnimationFrame: opts.onPeerAnimationFrame,
    ringTimeoutMs: opts.ringTimeoutMs,
  });
  const callee = new CallOrchestrator({
    myUserId: 'bob',
    signalProtocol: new MockSignalProtocolClient(),
    api: { fetchTurnCredentials: vi.fn(async () => []) } as any,
    peerFactory: calleeFactory,
    getDeviceToken: async () => 'dvt_bob',
    send: (frame) => calleeOut.push(frame),
    ensureSessionWithPeer: (async () => {}) as any,
    onStateChange: () => {},
    onCallFinished: (e) => finishedCallee.push(e),
    onPeerAnimationFrame: opts.onPeerAnimationFrame,
    ringTimeoutMs: opts.ringTimeoutMs,
  });

  async function pump(): Promise<void> {
    // Bounded loop — every dispatched frame may produce zero or one
    // follow-on frame from the receiver, so total work is finite.
    for (let i = 0; i < 50; i++) {
      const a = callerOut.shift();
      const b = calleeOut.shift();
      if (!a && !b) return;
      if (a) await callee.handleFrame(toServerFrame(a, 'alice'));
      if (b) await caller.handleFrame(toServerFrame(b, 'bob'));
    }
  }

  return {
    caller,
    callee,
    callerPeer: () => callerPeerInstance!,
    calleePeer: () => calleePeerInstance!,
    callerOut,
    calleeOut,
    pump,
    finishedCaller,
    finishedCallee,
  };
}

function toServerFrame(frame: WsClientMsg, fromUser: string): WsServerMsg {
  if (frame.type === 'call_offer') {
    return {
      type: 'call_offer',
      from: fromUser,
      call_id: frame.call_id,
      ciphertext: frame.ciphertext,
    };
  }
  if (frame.type === 'call_answer') {
    return {
      type: 'call_answer',
      from: fromUser,
      call_id: frame.call_id,
      ciphertext: frame.ciphertext,
    };
  }
  if (frame.type === 'call_ice') {
    return {
      type: 'call_ice',
      from: fromUser,
      call_id: frame.call_id,
      ciphertext: frame.ciphertext,
    };
  }
  if (frame.type === 'call_end') {
    return {
      type: 'call_end',
      from: fromUser,
      call_id: frame.call_id,
      reason: frame.reason,
    };
  }
  throw new Error('unexpected non-call frame');
}

describe('CallOrchestrator', () => {
  it('dial → ring → accept → connected → callee hangs up', async () => {
    const h = makeOrchHarness();
    await h.caller.startOutgoing('bob');
    expect(h.caller.getActive()?.stage).toBe('outgoing_ringing');
    await h.pump();
    expect(h.callee.getActive()?.stage).toBe('incoming_ringing');

    await h.callee.accept();
    await h.pump();
    expect(h.caller.getActive()?.stage).toBe('connecting');
    expect(h.callee.getActive()?.stage).toBe('connecting');

    h.callerPeer().emitConnState('connected');
    h.calleePeer().emitConnState('connected');
    expect(h.caller.getActive()?.stage).toBe('connected');
    expect(h.callee.getActive()?.stage).toBe('connected');

    h.callee.hangup();
    await h.pump();
    expect(h.caller.getActive()).toBeUndefined();
    expect(h.callee.getActive()).toBeUndefined();
    expect(h.callerPeer().closed).toBe(true);
    expect(h.calleePeer().closed).toBe(true);
    expect(h.finishedCaller[0]?.reason).toBe('completed');
    expect(h.finishedCallee[0]?.reason).toBe('completed');
  });

  it('callee declines an incoming call', async () => {
    const h = makeOrchHarness();
    await h.caller.startOutgoing('bob');
    await h.pump();
    expect(h.callee.getActive()?.stage).toBe('incoming_ringing');
    h.callee.decline();
    await h.pump();
    expect(h.caller.getActive()).toBeUndefined();
    expect(h.callee.getActive()).toBeUndefined();
    expect(h.finishedCaller[0]?.reason).toBe('decline');
    expect(h.finishedCallee[0]?.reason).toBe('decline');
  });

  it('caller cancels before callee answers', async () => {
    const h = makeOrchHarness();
    await h.caller.startOutgoing('bob');
    await h.pump();
    expect(h.callee.getActive()?.stage).toBe('incoming_ringing');
    h.caller.hangup();
    await h.pump();
    expect(h.caller.getActive()).toBeUndefined();
    expect(h.callee.getActive()).toBeUndefined();
    expect(h.finishedCaller[0]?.reason).toBe('cancel');
    // Callee sees the wire `cancel` and records it as `no_answer`
    // locally — they didn't decline, the call was simply withdrawn.
    expect(h.finishedCallee[0]?.reason).toBe('no_answer');
  });

  it('busy: a second incoming offer while in a call is rejected', async () => {
    const h = makeOrchHarness();
    await h.caller.startOutgoing('bob');
    await h.pump();
    await h.callee.accept();
    await h.pump();
    h.callerPeer().emitConnState('connected');
    h.calleePeer().emitConnState('connected');
    expect(h.callee.getActive()?.stage).toBe('connected');

    // Synthesize a third party (carol) calling bob.
    const fakeOffer = Buffer.from(
      JSON.stringify({ v: 1, sdp: 'x', candidates: [] }),
    ).toString('base64');
    await h.callee.handleFrame({
      type: 'call_offer',
      from: 'carol',
      call_id: 'call-other',
      // Mock signal decrypt strips the 0x02 marker if present, otherwise
      // returns input as-is — both are fine for the busy path because
      // we never reach decrypt (the busy short-circuit fires first).
      ciphertext: fakeOffer,
    });
    // Bob's active call still belongs to alice.
    expect(h.callee.getActive()?.peerUserId).toBe('alice');
    // The busy path used bob's send callback to push a `call_end{busy}`
    // back to carol — but carol isn't part of this test pair, so the
    // pump just discards it (caller.handleFrame ignores end-frames for
    // unknown call ids). The relevant invariants are above.
  });

  it('ring timeout: caller transitions to no_answer; callee also times out', async () => {
    vi.useFakeTimers();
    const h = makeOrchHarness({ ringTimeoutMs: 1000 });
    await h.caller.startOutgoing('bob');
    await h.pump();
    await vi.advanceTimersByTimeAsync(1500);
    await h.pump();
    expect(h.caller.getActive()).toBeUndefined();
    expect(h.callee.getActive()).toBeUndefined();
    expect(h.finishedCaller[0]?.reason).toBe('no_answer');
    expect(h.finishedCallee[0]?.reason).toBe('no_answer');
    vi.useRealTimers();
  });

  it('mic / speaker toggles propagate to the peer', async () => {
    const h = makeOrchHarness();
    await h.caller.startOutgoing('bob');
    h.caller.setMicMuted(true);
    h.caller.setSpeakerOn(true);
    expect(h.callerPeer().micMuted).toBe(true);
    expect(h.callerPeer().speakerOn).toBe(true);
  });

  it('cannot startOutgoing while another call is active', async () => {
    const h = makeOrchHarness();
    await h.caller.startOutgoing('bob');
    await expect(h.caller.startOutgoing('carol')).rejects.toThrow(/busy/);
  });

  /**
   * Private Call wire-reason translation (Phase 5j). The sender's
   * filter dying sends `filter_failure` on the wire — locally, that's
   * accurate (MY filter failed). The receiver receives the same wire
   * value but its meaning flips: "the OTHER party's filter failed."
   * The orchestrator translates wire `filter_failure` → local
   * `peer_filter_failure` so CallScreen's inline failure UI shows the
   * correct copy.
   */
  describe('Private Call wire-reason translation', () => {
    it('endWithFilterFailure sends filter_failure and stores filter_failure locally', async () => {
      const h = makeOrchHarness();
      await h.caller.startOutgoing('bob');
      await h.pump();
      await h.callee.accept();
      await h.pump();
      h.callerPeer().emitConnState('connected');
      h.calleePeer().emitConnState('connected');
      expect(h.caller.getActive()?.stage).toBe('connected');

      // The local side's filter dies mid-call.
      h.caller.endWithFilterFailure();
      // Caller side: local reason is 'filter_failure'.
      expect(h.finishedCaller[0]?.reason).toBe('filter_failure');
      // Wire frame went to bob with reason 'filter_failure'.
      const callEnd = h.callerOut.find((f) => f.type === 'call_end');
      expect(callEnd && callEnd.type === 'call_end' && callEnd.reason).toBe(
        'filter_failure',
      );
    });

    it('callee receives wire filter_failure → stores peer_filter_failure locally', async () => {
      const h = makeOrchHarness();
      await h.caller.startOutgoing('bob');
      await h.pump();
      await h.callee.accept();
      await h.pump();
      h.callerPeer().emitConnState('connected');
      h.calleePeer().emitConnState('connected');
      expect(h.callee.getActive()?.stage).toBe('connected');

      // Alice's filter dies; her endWithFilterFailure ships
      // call_end{filter_failure} to bob over the wire.
      h.caller.endWithFilterFailure();
      await h.pump();
      // Bob's local POV: alice's filter failed → peer_filter_failure.
      expect(h.finishedCallee[0]?.reason).toBe('peer_filter_failure');
    });

    it('rejects malformed wire peer_filter_failure (only sender of failed filter ships filter_failure)', async () => {
      const h = makeOrchHarness();
      await h.caller.startOutgoing('bob');
      await h.pump();
      await h.callee.accept();
      await h.pump();
      h.callerPeer().emitConnState('connected');
      h.calleePeer().emitConnState('connected');

      // Synthesize a malformed inbound: alice claims peer_filter_failure
      // (which by contract she'd never send — she'd send filter_failure
      // if her filter died). The receiver should fall back to a generic
      // hangup so the UI doesn't get stuck on a malformed code.
      await h.callee.handleFrame({
        type: 'call_end',
        from: 'alice',
        call_id: h.callee.getActive()!.callId,
        reason: 'peer_filter_failure',
      });
      expect(h.finishedCallee[0]?.reason).toBe('hangup');
    });
  });

  /**
   * KNOWN_CALL_KINDS guard (Phase 5j Private Call). The plan's
   * "Wire `call_end` reasons" + "Regression test — `kind ?? 'audio'`
   * fix" sections turned the pre-rc.130 silent-coerce into an explicit
   * KNOWN_CALL_KINDS check. The brand-promise hole this closes: a
   * sender at rc.130+ ships `kind:'private'` over the wire; a peer
   * still on rc.129 silently coerces to `'audio'` and rings the call
   * with raw microphone audio while the sender believes their voice
   * is masked. Codex tension #1 from /plan-eng-review surfaced this;
   * the fix is the server-side capability fan-out filter PLUS the
   * receiver-side guard here as defense in depth.
   *
   * The matrix below enforces all six cases the plan named.
   */
  describe('handleIncomingOffer KNOWN_CALL_KINDS guard', () => {
    /**
     * Build a fake call_offer ciphertext for the matrix. Mirrors
     * MockSignalProtocolClient.encrypt: JSON → bytes → prepend 0x02
     * SignalMessage marker → base64. Pass any payload shape including
     * non-typed-safe ones so we can exercise the unknown-kind rejection.
     */
    function makeOffer(payload: unknown): string {
      const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
      const out = new Uint8Array(jsonBytes.length + 1);
      out[0] = 0x02;
      out.set(jsonBytes, 1);
      return Buffer.from(out).toString('base64');
    }

    async function deliver(h: OrchHarness, payload: unknown): Promise<void> {
      await h.callee.handleFrame({
        type: 'call_offer',
        from: 'alice',
        call_id: 'matrix-call',
        ciphertext: makeOffer(payload),
      });
    }

    it("accepts kind:'audio' (existing behavior preserved)", async () => {
      const h = makeOrchHarness();
      await deliver(h, { v: 1, sdp: 'x', candidates: [], kind: 'audio' });
      expect(h.callee.getActive()?.stage).toBe('incoming_ringing');
      expect(h.callee.getActive()?.kind).toBe('audio');
    });

    it("accepts kind:'video' (existing)", async () => {
      const h = makeOrchHarness();
      await deliver(h, { v: 1, sdp: 'x', candidates: [], kind: 'video' });
      expect(h.callee.getActive()?.stage).toBe('incoming_ringing');
      expect(h.callee.getActive()?.kind).toBe('video');
    });

    it('accepts undefined kind, coerces to audio (back-compat with pre-rc.34 clients)', async () => {
      const h = makeOrchHarness();
      await deliver(h, { v: 1, sdp: 'x', candidates: [] });
      expect(h.callee.getActive()?.stage).toBe('incoming_ringing');
      expect(h.callee.getActive()?.kind).toBe('audio');
    });

    it("accepts kind:'private' (new — Phase 5j)", async () => {
      const h = makeOrchHarness();
      await deliver(h, { v: 1, sdp: 'x', candidates: [], kind: 'private' });
      expect(h.callee.getActive()?.stage).toBe('incoming_ringing');
      expect(h.callee.getActive()?.kind).toBe('private');
    });

    it("rejects kind:'foo' — was previously silently coerced to 'audio' (brand-promise hole)", async () => {
      const h = makeOrchHarness();
      await deliver(h, { v: 1, sdp: 'x', candidates: [], kind: 'foo' });
      // Silent abort: no active call established, no call_end sent.
      expect(h.callee.getActive()).toBeUndefined();
      expect(h.calleeOut).toHaveLength(0);
    });

    it('rejects kind:null with the same silent-abort path', async () => {
      const h = makeOrchHarness();
      await deliver(h, { v: 1, sdp: 'x', candidates: [], kind: null });
      expect(h.callee.getActive()).toBeUndefined();
      expect(h.calleeOut).toHaveLength(0);
    });
  });

  /**
   * Phase 5j Private Call — animation data channel. The orchestrator
   * sits between the audio-pipeline owner (native filter shim) and
   * the peer's avatar Render, encoding/decoding the per-frame state
   * and propagating to the receiver-side store via the
   * onPeerAnimationFrame deps callback.
   */
  describe('animation data channel', () => {
    it('caller opens the animation channel on a private outgoing call', async () => {
      const h = makeOrchHarness();
      await h.caller.startOutgoing('bob', 'private');
      expect(h.callerPeer().animationChannelOpen).toBe(true);
    });

    it('does NOT open the animation channel for kind:audio', async () => {
      const h = makeOrchHarness();
      await h.caller.startOutgoing('bob', 'audio');
      expect(h.callerPeer().animationChannelOpen).toBe(false);
    });

    it('sendAnimationFrame round-trips through the peer to onPeerAnimationFrame', async () => {
      const peerAnimationFrames: Array<{ peerUserId: string; frame: any }> = [];
      const h = makeOrchHarness({
        onPeerAnimationFrame: (peerUserId, frame) => {
          peerAnimationFrames.push({ peerUserId, frame });
        },
      });
      await h.caller.startOutgoing('bob', 'private');
      await h.pump();
      await h.callee.accept();
      await h.pump();
      h.callerPeer().emitConnState('connected');
      h.calleePeer().emitConnState('connected');

      // Alice ships a frame; bob's mock peer relays it as if the wire
      // delivered it. The orchestrator decodes and forwards.
      const seq = h.caller.sendAnimationFrame({
        amplitude: 0.5,
        emotionState: 'excited',
        pitchNorm: 0.7,
        zcrNorm: 0.3,
      });
      expect(seq).toBe(1);
      expect(h.callerPeer().sentAnimationFrames).toHaveLength(1);
      h.calleePeer().emitAnimationFrame(h.callerPeer().sentAnimationFrames[0]!);

      expect(peerAnimationFrames).toHaveLength(1);
      expect(peerAnimationFrames[0]?.peerUserId).toBe('alice');
      expect(peerAnimationFrames[0]?.frame.emotionState).toBe('excited');
      expect(peerAnimationFrames[0]?.frame.amplitude).toBeCloseTo(0.5, 2);
    });

    it('drops out-of-order frames (fresh-or-drop semantics)', async () => {
      const peerAnimationFrames: any[] = [];
      const h = makeOrchHarness({
        onPeerAnimationFrame: (_pid, frame) => peerAnimationFrames.push(frame),
      });
      await h.caller.startOutgoing('bob', 'private');
      await h.pump();
      await h.callee.accept();
      await h.pump();

      h.caller.sendAnimationFrame({
        amplitude: 0.1,
        emotionState: 'baseline',
        pitchNorm: 0,
        zcrNorm: 0,
      });
      h.caller.sendAnimationFrame({
        amplitude: 0.5,
        emotionState: 'excited',
        pitchNorm: 0.7,
        zcrNorm: 0.5,
      });
      const frames = h.callerPeer().sentAnimationFrames;
      // Deliver in order: 1, 2 — both accepted.
      h.calleePeer().emitAnimationFrame(frames[0]!);
      h.calleePeer().emitAnimationFrame(frames[1]!);
      // Re-deliver seq=1 (the stale one) — dropped.
      h.calleePeer().emitAnimationFrame(frames[0]!);

      expect(peerAnimationFrames).toHaveLength(2);
      expect(peerAnimationFrames[0]?.amplitude).toBeCloseTo(0.1, 2);
      expect(peerAnimationFrames[1]?.amplitude).toBeCloseTo(0.5, 2);
    });

    it('sendAnimationFrame returns -1 (no-op) when there is no active call', () => {
      const h = makeOrchHarness();
      expect(
        h.caller.sendAnimationFrame({
          amplitude: 0.5,
          emotionState: 'excited',
          pitchNorm: 0.5,
          zcrNorm: 0.5,
        }),
      ).toBe(-1);
    });

    it('cleanup resets outboundAnimationSeq so the next call starts at 1', async () => {
      const h = makeOrchHarness();
      await h.caller.startOutgoing('bob', 'private');
      await h.pump();
      const seq1 = h.caller.sendAnimationFrame({
        amplitude: 0.1,
        emotionState: 'baseline',
        pitchNorm: 0,
        zcrNorm: 0,
      });
      expect(seq1).toBe(1);
      h.caller.hangup();
      await h.pump();
      // Fresh dial — the same orchestrator must restart the seq
      // counter (cleanup() resets outboundAnimationSeq).
      await h.caller.startOutgoing('bob', 'private');
      const seq2 = h.caller.sendAnimationFrame({
        amplitude: 0.1,
        emotionState: 'baseline',
        pitchNorm: 0,
        zcrNorm: 0,
      });
      expect(seq2).toBe(1);
    });
  });
});
