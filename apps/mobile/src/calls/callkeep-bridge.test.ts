import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCalls } from '../store/calls.js';
import type { NativeCallKitReport, NativeCallKitReportSource } from '../native/callkit.js';
import { CallKeepBridge } from './callkeep-bridge.js';
import type { ActiveCall } from './types.js';

const CALL_ID = 'call-01M1AJ1HXE7A4GPFDF0B9QNWG9';
const NATIVE_UUID = 'f5dcb01e-2619-54b4-bfc4-9f9db17efb32';
const SIBLING_UUID = '90a63483-79f1-4dda-b0b0-63a4ba62f642';

function nativeReportFeed(initialReports: NativeCallKitReport[] = []) {
  const listeners = new Set<(report: NativeCallKitReport) => void>();
  const source: NativeCallKitReportSource = {
    drain: vi.fn(async () => initialReports),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    acknowledge: vi.fn(),
  };
  return {
    source,
    emit: (report: NativeCallKitReport) => {
      for (const listener of listeners) listener(report);
    },
  };
}

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
  orphanCleanupDelayMs = 30_000,
  feed = nativeReportFeed(initialReports),
) {
  const listeners = new Map<string, (value: any) => void>();
  const callKeep = {
    setup: vi.fn(async () => undefined),
    registerAndroidEvents: vi.fn(),
    setAvailable: vi.fn(),
    addEventListener: vi.fn((event: string, listener: (value: any) => void) => {
      listeners.set(event, listener);
    }),
    removeEventListener: vi.fn((event: string) => listeners.delete(event)),
    getInitialEvents: vi.fn(async () => initialEvents),
    clearInitialEvents: vi.fn(),
    startCall: vi.fn(),
    displayIncomingCall: vi.fn(),
    endCall: vi.fn(),
    reportEndCallWithUUID: vi.fn(),
    reportConnectedOutgoingCallWithUUID: vi.fn(),
  };
  const nativeReports = feed.source;
  const orchestrator = {
    getActive: () => useCalls.getState().active,
    accept: vi.fn(async () => undefined),
    decline: vi.fn(),
    hangup: vi.fn(),
    setMicMuted: vi.fn(),
    showIncomingCallFallback: vi.fn(),
  };
  const bridge = new CallKeepBridge({
    orchestrator: orchestrator as never,
    callKeep,
    nativeReports,
    platform: 'ios',
    incomingFallbackDelayMs,
    orphanCleanupDelayMs,
  });
  return {
    bridge,
    callKeep,
    nativeReports,
    orchestrator,
    emitCallKeep: (event: string, value: any) => listeners.get(event)?.(value),
    emitNativeReport: feed.emit,
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
    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    expect(h.nativeReports.acknowledge).not.toHaveBeenCalled();

    useCalls.getState().setActive(incoming());
    expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(NATIVE_UUID);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();

    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID.toUpperCase() });
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();

    useCalls.getState().setActive(undefined);
    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 2);
    h.bridge.stop();
  });

  it('remains adopt-only when the signaling offer arrives before the native handoff', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bridge.start();

    useCalls.getState().setActive(incoming());
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();

    h.emitNativeReport({ callId: CALL_ID, callUUID: NATIVE_UUID });
    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID });
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    h.bridge.stop();
  });

  it('releases one bounded in-app fallback when no native report arrives', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bridge.start();

    useCalls.getState().setActive(incoming());
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    expect(h.orchestrator.showIncomingCallFallback).toHaveBeenCalledWith(CALL_ID);
    h.bridge.stop();
  });

  it('releases the in-app fallback when CallKeep setup fails', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.callKeep.setup.mockRejectedValueOnce(new Error('CallKeep setup unavailable'));
    await h.bridge.start();

    useCalls.getState().setActive(incoming());
    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    expect(h.orchestrator.showIncomingCallFallback).toHaveBeenCalledWith(CALL_ID);
    h.bridge.stop();
  });

  it('does not create a second CallKit UUID when native confirmation is delayed', async () => {
    vi.useFakeTimers();
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    useCalls.getState().setActive(incoming());

    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    expect(h.callKeep.reportEndCallWithUUID).not.toHaveBeenCalledWith(NATIVE_UUID, 1);
    expect(h.orchestrator.showIncomingCallFallback).toHaveBeenCalledWith(CALL_ID);
    h.bridge.stop();
  });

  it('routes an authoritative end action to one decline without answering or hanging up', async () => {
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    useCalls.getState().setActive(incoming());

    h.emitCallKeep('endCall', { callUUID: NATIVE_UUID });

    expect(h.orchestrator.decline).toHaveBeenCalledOnce();
    expect(h.orchestrator.accept).not.toHaveBeenCalled();
    expect(h.orchestrator.hangup).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('does not recover a locally requested end as an orphan', async () => {
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    useCalls.getState().setActive(incoming());

    useCalls.getState().setActive(undefined);

    expect(h.callKeep.endCall).not.toHaveBeenCalled();
    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 2);
    expect(h.callKeep.reportEndCallWithUUID).not.toHaveBeenCalledWith(NATIVE_UUID, 1);
    expect(h.orchestrator.decline).not.toHaveBeenCalled();
    expect(h.orchestrator.hangup).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('ends a rejected call immediately when its native mapping arrives late', async () => {
    const rejectedCallId = 'call-01M1AJ1HXE7A4GPFDF0B9QNR01';
    const h = harness();
    await h.bridge.start();

    h.bridge.rejectIncomingCall(rejectedCallId);
    h.emitNativeReport({ callId: rejectedCallId, callUUID: NATIVE_UUID });

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 1);
    expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(NATIVE_UUID);
    h.bridge.stop();
  });

  it('ends every duplicate native handoff for a recently rejected call', async () => {
    const rejectedCallId = 'call-01M1AJ1HXE7A4GPFDF0B9QNR02';
    const h = harness();
    await h.bridge.start();

    h.bridge.rejectIncomingCall(rejectedCallId);
    h.emitNativeReport({ callId: rejectedCallId, callUUID: NATIVE_UUID });
    h.emitNativeReport({ callId: rejectedCallId, callUUID: NATIVE_UUID });

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledTimes(2);
    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenNthCalledWith(1, NATIVE_UUID, 1);
    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenNthCalledWith(2, NATIVE_UUID, 1);
    expect(h.nativeReports.acknowledge).toHaveBeenCalledTimes(2);
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

  it('ends a fresh native report that never matches signaling and acknowledges persistence', async () => {
    vi.useFakeTimers();
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }], [], 1_500, 5_000);

    await h.bridge.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 1);
    expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(NATIVE_UUID);
    h.bridge.stop();
  });

  it('uses the fallback when the authoritative native report fails', async () => {
    vi.useFakeTimers();
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    useCalls.getState().setActive(incoming());

    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      error: 'CallKit rejected the report',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.callKeep.displayIncomingCall).toHaveBeenCalledOnce();
    expect(h.callKeep.displayIncomingCall.mock.calls[0]?.[0]).toBe(NATIVE_UUID);
    expect(h.nativeReports.acknowledge).toHaveBeenCalledWith(NATIVE_UUID);
    h.bridge.stop();
  });

  it('adopts a duplicate PushKit report that CallKit says already exists', async () => {
    vi.useFakeTimers();
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    useCalls.getState().setActive(incoming());

    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      error: 'An incoming call with this UUID already exists',
      errorCode: 'CallUUIDAlreadyExists',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID });

    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    expect(h.callKeep.reportEndCallWithUUID).not.toHaveBeenCalledWith(NATIVE_UUID, 1);
    h.bridge.stop();
  });

  it('releases incoming UI to the app when the JS CallKit fallback fails', async () => {
    vi.useFakeTimers();
    const h = harness([{ callId: CALL_ID, callUUID: NATIVE_UUID }]);
    await h.bridge.start();
    useCalls.getState().setActive(incoming());
    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      error: 'Native report failed',
      errorCode: 'Unknown',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    const fallbackUUID = h.callKeep.displayIncomingCall.mock.calls[0]?.[0];

    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: fallbackUUID,
      fromPushKit: '0',
      error: 'Missing CallKit entitlement',
      errorCode: 'Unentitled',
    });

    expect(h.orchestrator.showIncomingCallFallback).toHaveBeenCalledOnce();
    expect(h.orchestrator.showIncomingCallFallback).toHaveBeenCalledWith(CALL_ID);
    h.bridge.stop();
  });

  it('does not let a stopped bridge orphan a report owned by its replacement', async () => {
    vi.useFakeTimers();
    const feed = nativeReportFeed();
    const stale = harness([], [], 1_500, 100, feed);
    await stale.bridge.start();
    stale.bridge.stop();
    const replacement = harness([], [], 1_500, 100, feed);
    await replacement.bridge.start();

    feed.emit({ callId: CALL_ID, callUUID: NATIVE_UUID });
    await vi.advanceTimersByTimeAsync(100);

    expect(stale.callKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    expect(replacement.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 1);
    replacement.bridge.stop();
  });

  it('transfers a rejection across bridge replacement until native handoff arrives', async () => {
    const rejectedCallId = 'call-01M1AJ1HXE7A4GPFDF0B9QNR03';
    const feed = nativeReportFeed();
    const stale = harness([], [], 1_500, 30_000, feed);
    await stale.bridge.start();
    stale.bridge.rejectIncomingCall(rejectedCallId);
    stale.bridge.stop();
    const replacement = harness([], [], 1_500, 30_000, feed);
    await replacement.bridge.start();

    feed.emit({ callId: rejectedCallId, callUUID: NATIVE_UUID });

    expect(replacement.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(NATIVE_UUID, 1);
    expect(replacement.nativeReports.acknowledge).toHaveBeenCalledWith(NATIVE_UUID);
    replacement.bridge.stop();
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

    await vi.waitFor(() =>
      expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(SIBLING_UUID, 1),
    );
    useCalls.getState().setActive(incoming());
    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID });
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    expect(h.callKeep.displayIncomingCall).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('ignores a delayed display callback for a superseded native UUID', async () => {
    const h = harness([{ callId: CALL_ID, callUUID: SIBLING_UUID }]);
    await h.bridge.start();
    h.emitNativeReport({ callId: CALL_ID, callUUID: NATIVE_UUID });

    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: SIBLING_UUID,
      fromPushKit: '1',
      payload: { call_id: CALL_ID, call_uuid: SIBLING_UUID },
    });
    h.emitCallKeep('didDisplayIncomingCall', {
      callUUID: NATIVE_UUID,
      fromPushKit: '1',
      payload: { call_id: CALL_ID, call_uuid: NATIVE_UUID },
    });
    useCalls.getState().setActive(incoming());
    h.emitCallKeep('answerCall', { callUUID: NATIVE_UUID });

    expect(h.callKeep.reportEndCallWithUUID).toHaveBeenCalledWith(SIBLING_UUID, 1);
    expect(h.callKeep.reportEndCallWithUUID).not.toHaveBeenCalledWith(NATIVE_UUID, 1);
    expect(h.orchestrator.accept).toHaveBeenCalledOnce();
    h.bridge.stop();
  });
});
