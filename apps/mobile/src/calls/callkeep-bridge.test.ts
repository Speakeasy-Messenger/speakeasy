import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCalls } from '../store/calls.js';
import type { NativeCallKitReport, NativeCallKitReportSource } from '../native/callkit.js';
import { CallKeepBridge } from './callkeep-bridge.js';
import type { ActiveCall } from './types.js';

const CALL_ID = 'call-01M1AJ1HXE7A4GPFDF0B9QNWG9';
const NATIVE_UUID = 'f5dcb01e-2619-54b4-bfc4-9f9db17efb32';
const SIBLING_UUID = '90a63483-79f1-4dda-b0b0-63a4ba62f642';

function incoming(): ActiveCall {
  return {
    callId: CALL_ID,
    peerUserId: 'android-peer',
    isCaller: false,
    stage: 'incoming_ringing',
    stageEnteredAt: 1,
    micMuted: false,
    speakerOn: false,
    kind: 'audio',
  };
}

function harness(
  initialReports: NativeCallKitReport[] = [],
  initialEvents: Array<{ name: string; data?: any }> = [],
  incomingFallbackDelayMs = 1_500,
) {
  const listeners = new Map<string, (value: any) => void>();
  let nativeListener: ((report: NativeCallKitReport) => void) | undefined;
  const callKeep = {
    setup: vi.fn(async () => undefined),
    registerAndroidEvents: vi.fn(),
    setAvailable: vi.fn(),
    addEventListener: vi.fn((event: string, listener: (value: any) => void) => {
      listeners.set(event, listener);
    }),
    removeEventListener: vi.fn(),
    getInitialEvents: vi.fn(async () => initialEvents),
    clearInitialEvents: vi.fn(),
    startCall: vi.fn(),
    displayIncomingCall: vi.fn(),
    endCall: vi.fn(),
    reportEndCallWithUUID: vi.fn(),
    reportConnectedOutgoingCallWithUUID: vi.fn(),
  };
  const nativeReports: NativeCallKitReportSource = {
    drain: vi.fn(async () => initialReports),
    subscribe: vi.fn((listener) => {
      nativeListener = listener;
      return () => {
        nativeListener = undefined;
      };
    }),
  };
  const orchestrator = {
    getActive: () => useCalls.getState().active,
    accept: vi.fn(async () => undefined),
    decline: vi.fn(),
    hangup: vi.fn(),
    setMicMuted: vi.fn(),
  };
  const bridge = new CallKeepBridge({
    orchestrator: orchestrator as never,
    callKeep,
    nativeReports,
    platform: 'ios',
    incomingFallbackDelayMs,
  });
  return {
    bridge,
    callKeep,
    orchestrator,
    emitCallKeep: (event: string, value: any) => listeners.get(event)?.(value),
    emitNativeReport: (report: NativeCallKitReport) => nativeListener?.(report),
  };
}

afterEach(() => {
  vi.useRealTimers();
  useCalls.setState({ active: undefined });
});

describe('CallKeepBridge native PushKit adoption', () => {
  it('adopts the native mapping, never displays a sibling, and routes answer to it', async () => {
    vi.useFakeTimers();
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();

    useCalls.getState().setActive(incoming());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();

    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID.toUpperCase() });
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();

    useCalls.getState().setActive(undefined);
    expect(h.callKeep.endCall).toHaveBeenCalledWith(NATIVE_UUID);
    h.bridge.stop();
  });

  it('remains adopt-only when the signaling offer arrives before the native handoff', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bridge.start();

    useCalls.getState().setActive(incoming());
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();

    h.emitNativeReport({ callId: CALL_ID, callUUID: NATIVE_UUID });
    await vi.advanceTimersByTimeAsync(2_000);
    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID });
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    h.bridge.stop();
  });

  it('displays one bounded fallback when no native report arrives', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bridge.start();

    useCalls.getState().setActive(incoming());
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.callKeep.displayIncomingCall).toHaveBeenCalledOnce();
    expect(h.callKeep.displayIncomingCall).toHaveBeenCalledWith(
      expect.any(String),
      'android-peer',
      '@android-peer',
      'generic',
      false,
    );
    h.bridge.stop();
  });

  it('routes an authoritative end action to one decline without answering or hanging up', async () => {
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    useCalls.getState().setActive(incoming());

    h.emitCallKeep('endCall', { callUUID: NATIVE_UUID });

    expect(h.orchestrator.decline).toHaveBeenCalledOnce();
    expect(h.orchestrator.accept).not.toHaveBeenCalled();
    expect(h.orchestrator.hangup).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('reports an unmapped PushKit CallKit call ended instead of leaving a phantom', async () => {
    const h = harness();
    await h.bridge.start();

    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
    });

    await vi.waitFor(() =>
      expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 1),
    );
    expect(h.orchestrator.accept).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('reports an expired persisted native mapping ended instead of adopting it', async () => {
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID, expired: true }]);

    await h.bridge.start();

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 1);
    useCalls.getState().setActive(incoming());
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('replays an early native answer only after the matching offer becomes active', async () => {
    const h = harness(
      [{ callId: CALL_ID, callUUID: NATIVE_UUID }],
      [
        {
          name: 'RNCallKeepPerformAnswerCallAction',
          data: { callUUID: NATIVE_UUID },
        },
      ],
    );

    await h.bridge.start();
    expect(h.orchestrator.accept).not.toHaveBeenCalled();
    useCalls.getState().setActive(incoming());

    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('ends a legacy sibling UUID before adopting the authoritative native UUID', async () => {
    const h = harness();
    await h.bridge.start();
    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: SIBLING_UUID,
      fromPushKit: '1',
      payload: { call_id: CALL_ID, call_uuid: SIBLING_UUID },
    });

    h.emitNativeReport({ callId: CALL_ID, callUUID: NATIVE_UUID });

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(SIBLING_UUID, 1);
    useCalls.getState().setActive(incoming());
    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID });
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    h.bridge.stop();
  });
});
