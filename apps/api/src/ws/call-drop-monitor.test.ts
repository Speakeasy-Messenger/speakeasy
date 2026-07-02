import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createCallDropMonitor,
  DEFAULT_CALL_DROP_GRACE_MS,
  type CallDropMonitorDeps,
} from './call-drop-monitor.js';
import type { UserNotifier } from './user-notifier.js';
import type { FastifyBaseLogger } from 'fastify';

function makeDeps(over: Partial<CallDropMonitorDeps> = {}): {
  deps: CallDropMonitorDeps;
  notify: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} {
  const notify = vi.fn();
  const record = vi.fn().mockResolvedValue(undefined);
  const userNotifier = { notify } as unknown as UserNotifier;
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const deps: CallDropMonitorDeps = {
    userNotifier,
    log,
    eventLog: { record } as never,
    ...over,
  };
  return { deps, notify, record };
}

const ARGS = {
  userId: 'alice',
  deviceToken: 'dev-alice-1',
  callId: 'call-001',
  peerUserId: 'bob',
};

describe('createCallDropMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the call for the peer after the grace window when nobody reconnects', () => {
    const { deps, notify, record } = makeDeps();
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);

    // Nothing fires before the window elapses.
    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('bob', {
      type: 'call_end',
      from: 'alice',
      call_id: 'call-001',
      reason: 'peer_disconnected',
    });
    // Diagnostics recorded against the surviving peer.
    expect(record).toHaveBeenCalledWith({
      eventType: 'call.peer_disconnected.ended',
      userId: 'bob',
      payload: { callId: 'call-001', droppedUserId: 'alice' },
    });
  });

  it('cancels the pending end when the same device reconnects in time', () => {
    const { deps, notify } = makeDeps();
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);

    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS - 1);
    mon.cancel('dev-alice-1'); // reconnect lands just in time

    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a cancel for a DIFFERENT device does not save the call', () => {
    const { deps, notify } = makeDeps();
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);

    mon.cancel('dev-someone-else'); // unrelated device reconnecting
    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('re-arming the same device replaces the prior timer (no double end)', () => {
    const { deps, notify } = makeDeps();
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);
    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS - 1);
    // Same device drops again on a fresh call before the first fired.
    mon.arm({ ...ARGS, callId: 'call-002' });

    // The original timer must NOT fire (it was replaced).
    vi.advanceTimersByTime(1);
    expect(notify).not.toHaveBeenCalled();

    // Only the latest call ends, once, after a full fresh window.
    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS - 1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('bob', {
      type: 'call_end',
      from: 'alice',
      call_id: 'call-002',
      reason: 'peer_disconnected',
    });
  });

  it('honors a custom grace window', () => {
    const { deps, notify } = makeDeps({ graceMs: 500 });
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);
    vi.advanceTimersByTime(499);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('clearAll cancels every pending end (server shutdown)', () => {
    const { deps, notify } = makeDeps();
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);
    mon.arm({ ...ARGS, deviceToken: 'dev-carol-1', userId: 'carol', peerUserId: 'dave' });
    mon.clearAll();
    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it('works without an eventLog (best-effort diagnostics absent)', () => {
    const { deps, notify } = makeDeps({ eventLog: undefined });
    const mon = createCallDropMonitor(deps);
    mon.arm(ARGS);
    vi.advanceTimersByTime(DEFAULT_CALL_DROP_GRACE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
