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
  micMuted = false;
  speakerOn = false;
  closed = false;
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

function makeOrchHarness(opts: { ringTimeoutMs?: number } = {}): OrchHarness {
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
});
