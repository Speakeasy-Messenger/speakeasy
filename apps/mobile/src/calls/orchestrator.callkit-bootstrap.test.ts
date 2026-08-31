import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WsClientMsg } from '@speakeasy/shared';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import { CallKeepBridge } from './callkeep-bridge.js';
import { CallOrchestrator } from './orchestrator.js';

const UUIDS = [
  '38c37551-9389-55a1-b8fc-bab3ed28db31',
  '26686650-db46-5378-92d3-19da7c9a947d',
  'cda1e118-cf94-5fd7-9b09-ea5784eb60fb',
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
}) {
  const sent: WsClientMsg[] = [];
  const signalProtocol = new MockSignalProtocolClient();
  if (opts.decryptFailure) {
    vi.spyOn(signalProtocol, 'decrypt').mockRejectedValue(new Error('decrypt failed'));
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
  const nativeReports = {
    drain: vi.fn(async () => [{ callId: opts.callId, callUUID: opts.callUUID }]),
    subscribe: vi.fn(() => () => undefined),
    acknowledge: vi.fn(),
  };
  let bridge: CallKeepBridge | undefined;
  let startup: Promise<void> | undefined;
  const orchestrator = new CallOrchestrator({
    myUserId: 'ios-user',
    signalProtocol,
    api: { fetchTurnCredentials: vi.fn(async () => []) } as never,
    peerFactory: { create: vi.fn() } as never,
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
      };
    },
  });
  return {
    orchestrator,
    callKeep,
    nativeReports,
    sent,
    bridge: () => bridge!,
    startup: () => startup!,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CallOrchestrator iOS CallKit bootstrap', () => {
  it('ends unactivated native reports across every pre-ringing rejection path', async () => {
    vi.useFakeTimers();
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

      await vi.advanceTimersByTimeAsync(100);

      expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(scenario.callUUID, 1);
      expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(scenario.callUUID);
      h.orchestrator.dispose();
      expect(h.callKeep.removeEventListener).toHaveBeenCalled();
    }
  });
});
