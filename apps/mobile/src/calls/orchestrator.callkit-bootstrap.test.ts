import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WsClientMsg } from '@speakeasy/shared';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import type { NativeCallKitReport } from '../native/callkit.js';
import { CallKeepBridge } from './callkeep-bridge.js';
import { CallOrchestrator } from './orchestrator.js';

const UUIDS = [
  '38c37551-9389-55a1-b8fc-bab3ed28db31',
  '26686650-db46-5378-92d3-19da7c9a947d',
  'cda1e118-cf94-5fd7-9b09-ea5784eb60fb',
  '44d4bbbc-b7c2-58ea-a99d-1b0953136e20',
];

function offer(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload));
  const ciphertext = new Uint8Array(body.length + 1);
  ciphertext[0] = 0x02;
  ciphertext.set(body, 1);
  return Buffer.from(ciphertext).toString('base64');
}

function harness(opts: {
  callId: string;
  callUUID: string;
  allowIncoming?: boolean;
  decryptFailure?: boolean;
  deferDecrypt?: boolean;
  deferPeer?: boolean;
}) {
  const sent: WsClientMsg[] = [];
  const signalProtocol = new MockSignalProtocolClient();
  if (opts.decryptFailure) {
    vi.spyOn(signalProtocol, 'decrypt').mockRejectedValue(new Error('decrypt failed'));
  }
  let releaseDecrypt: (() => void) | undefined;
  if (opts.deferDecrypt) {
    const gate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    vi.spyOn(signalProtocol, 'decrypt').mockImplementation(async (_peer, ciphertext) => {
      await gate;
      return ciphertext.slice(1);
    });
  }
  const callKeep = {
    setup: vi.fn(async () => undefined),
    registerAndroidEvents: vi.fn(),
    setAvailable: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getInitialEvents: vi.fn(async () => []),
    clearInitialEvents: vi.fn(),
    startCall: vi.fn(),
    displayIncomingCall: vi.fn(),
    endCall: vi.fn(),
    reportEndCallWithUUID: vi.fn(),
    reportConnectedOutgoingCallWithUUID: vi.fn(),
  };
  let nativeReportListener: ((report: NativeCallKitReport) => void) | undefined;
  const nativeReports = {
    drain: vi.fn(async () => [{ callId: opts.callId, callUUID: opts.callUUID }]),
    subscribe: vi.fn((listener) => {
      nativeReportListener = listener;
      return () => {
        nativeReportListener = undefined;
      };
    }),
    acknowledge: vi.fn(),
  };
  const peer = {
    createOffer: vi.fn(async () => ({ v: 1, sdp: 'offer', candidates: [] })),
    setRemoteOffer: vi.fn(async () => undefined),
    onLocalIce: vi.fn(() => () => undefined),
    onConnectionStateChange: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
  let releasePeer: (() => void) | undefined;
  const peerGate = opts.deferPeer
    ? new Promise<void>((resolve) => {
        releasePeer = resolve;
      })
    : undefined;
  const peerFactory = {
    create: vi.fn(async () => {
      await peerGate;
      return peer;
    }),
  };
  let bridge: CallKeepBridge | undefined;
  let startup: Promise<void> | undefined;
  const orchestrator = new CallOrchestrator({
    myUserId: 'ios-user',
    signalProtocol,
    api: { fetchTurnCredentials: vi.fn(async () => []) } as never,
    peerFactory: peerFactory as never,
    getDeviceToken: async () => 'dvt-ios',
    send: (frame) => sent.push(frame),
    ensureSessionWithPeer: vi.fn() as never,
    onStateChange: vi.fn(),
    onCallFinished: vi.fn(),
    getAllowIncomingCalls: () => opts.allowIncoming ?? true,
    callKeepEnabled: true,
    callKeepFactory: (owner) => {
      bridge = new CallKeepBridge({
        orchestrator: owner,
        callKeep,
        nativeReports,
        platform: 'ios',
        orphanCleanupDelayMs: 100,
      });
      return {
        start: () => {
          startup = bridge!.start();
          return startup;
        },
        stop: () => bridge!.stop(),
        rejectIncomingCall: (callId) => bridge!.rejectIncomingCall(callId),
      };
    },
  });
  return {
    orchestrator,
    callKeep,
    nativeReports,
    sent,
    signalProtocol,
    peer,
    peerFactory,
    releaseDecrypt: () => releaseDecrypt?.(),
    releasePeer: () => releasePeer?.(),
    emitNativeReport: (callId: string, callUUID: string) =>
      nativeReportListener?.({ callId, callUUID }),
    bridge: () => bridge!,
    startup: () => startup!,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CallOrchestrator iOS CallKit bootstrap', () => {
  it('ends unactivated native reports across every pre-ringing rejection path', async () => {
    const cases = [
      {
        callId: 'call-decrypt-failure',
        callUUID: UUIDS[0]!,
        decryptFailure: true,
        payload: { v: 1, sdp: 'offer', candidates: [], kind: 'audio' },
        reason: 'hangup',
      },
      {
        callId: 'call-unknown-kind',
        callUUID: UUIDS[1]!,
        payload: { v: 1, sdp: 'offer', candidates: [], kind: 'future-kind' },
        reason: undefined,
      },
      {
        callId: 'call-policy-decline',
        callUUID: UUIDS[2]!,
        allowIncoming: false,
        payload: { v: 1, sdp: 'offer', candidates: [], kind: 'audio' },
        reason: 'decline',
      },
    ];

    for (const scenario of cases) {
      const h = harness(scenario);
      await h.startup();
      await h.orchestrator.handleFrame({
        type: 'call_offer',
        from: 'android-peer',
        call_id: scenario.callId,
        ciphertext: offer(scenario.payload),
      });
      expect(h.orchestrator.getActive()).toBeUndefined();
      const end = h.sent.find((frame) => frame.type === 'call_end');
      expect(end?.type === 'call_end' ? end.reason : undefined).toBe(scenario.reason);

      expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(scenario.callUUID, 1);
      expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(scenario.callUUID);
      h.orchestrator.dispose();
      expect(h.callKeep.removeEventListener).toHaveBeenCalled();
    }
  });

  it('ends a second native call immediately when signaling rejects it as busy', async () => {
    const h = harness({
      callId: 'call-active',
      callUUID: UUIDS[0]!,
    });
    await h.startup();
    await h.orchestrator.handleFrame({
      type: 'call_offer',
      from: 'android-peer',
      call_id: 'call-active',
      ciphertext: offer({ v: 1, sdp: 'offer', candidates: [], kind: 'audio' }),
    });
    h.emitNativeReport('call-busy', UUIDS[3]!);

    await h.orchestrator.handleFrame({
      type: 'call_offer',
      from: 'second-peer',
      call_id: 'call-busy',
      ciphertext: offer({ v: 1, sdp: 'offer', candidates: [], kind: 'audio' }),
    });

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(UUIDS[3], 1);
    expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(UUIDS[3]);
    h.orchestrator.dispose();
  });

  it('ends active CallKit ownership when its orchestrator is disposed', async () => {
    const h = harness({
      callId: 'call-remount-active',
      callUUID: UUIDS[1]!,
    });
    await h.startup();
    await h.orchestrator.handleFrame({
      type: 'call_offer',
      from: 'android-peer',
      call_id: 'call-remount-active',
      ciphertext: offer({ v: 1, sdp: 'offer', candidates: [], kind: 'audio' }),
    });

    h.orchestrator.dispose();

    expect(h.orchestrator.getActive()).toBeUndefined();
    expect(h.peer.close).toHaveBeenCalled();
    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(UUIDS[1], 2);
  });

  it('invalidates an in-flight offer when its orchestrator is disposed', async () => {
    const h = harness({
      callId: 'call-remount-in-flight',
      callUUID: UUIDS[2]!,
      deferDecrypt: true,
    });
    await h.startup();
    const processing = h.orchestrator.handleFrame({
      type: 'call_offer',
      from: 'android-peer',
      call_id: 'call-remount-in-flight',
      ciphertext: offer({ v: 1, sdp: 'offer', candidates: [], kind: 'audio' }),
    });
    await vi.waitFor(() => expect(h.signalProtocol.decrypt).toHaveBeenCalled());

    h.orchestrator.dispose();
    h.releaseDecrypt();
    await processing;

    expect(h.peerFactory.create).not.toHaveBeenCalled();
    expect(h.orchestrator.getActive()).toBeUndefined();
    expect(h.callKeep.setup).toHaveBeenCalledOnce();
    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(UUIDS[2], 2);
  });

  it('ends an unmatched native call as soon as its peer sends call_end', async () => {
    const h = harness({
      callId: 'call-ended-before-offer',
      callUUID: UUIDS[0]!,
    });
    await h.startup();

    await h.orchestrator.handleFrame({
      type: 'call_end',
      from: 'android-peer',
      call_id: 'call-ended-before-offer',
      reason: 'cancel',
    });

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(UUIDS[0], 1);
    expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(UUIDS[0]);
    h.orchestrator.dispose();
  });

  it('ignores a same-call end from an unexpected peer', async () => {
    const h = harness({
      callId: 'call-peer-guard',
      callUUID: UUIDS[1]!,
    });
    await h.startup();
    await h.orchestrator.handleFrame({
      type: 'call_offer',
      from: 'android-peer',
      call_id: 'call-peer-guard',
      ciphertext: offer({ v: 1, sdp: 'offer', candidates: [], kind: 'audio' }),
    });

    await h.orchestrator.handleFrame({
      type: 'call_end',
      from: 'unexpected-peer',
      call_id: 'call-peer-guard',
      reason: 'cancel',
    });

    expect(h.orchestrator.getActive()?.callId).toBe('call-peer-guard');
    expect(h.callKeep.reportEndCallWithUUID).not.toHaveBeenCalledWith(UUIDS[1], 1);
    h.orchestrator.dispose();
  });

  it('does not emit an outgoing offer after disposal during peer creation', async () => {
    const h = harness({
      callId: 'call-outgoing-remount',
      callUUID: UUIDS[2]!,
      deferPeer: true,
    });
    await h.startup();
    const dialing = h.orchestrator.startOutgoing('android-peer');
    await vi.waitFor(() => expect(h.peerFactory.create).toHaveBeenCalled());

    h.orchestrator.dispose();
    h.releasePeer();

    await expect(dialing).rejects.toThrow('orchestrator disposed');
    expect(h.peer.close).toHaveBeenCalled();
    expect(h.sent.filter((frame) => frame.type === 'call_offer')).toHaveLength(0);
  });
});
