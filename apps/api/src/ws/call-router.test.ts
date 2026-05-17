import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { routeCallFrame, type CallRouterDeps } from './call-router.js';
import { createCallOfferBuffer } from './call-offer-buffer.js';
import { InMemoryConnections } from './connections.js';
import { InMemoryPresence } from '../presence/memory.js';
import { MockPushProvider } from '../push/push.mock.js';

/**
 * Unit tests for the extracted call-signaling router.
 *
 * These exercise each branch (validation, push, online local, online
 * cross-instance, offline) directly with mock deps — no WS / Fastify
 * / buildServer infrastructure. End-to-end coverage continues to live
 * in handler.test.ts (single-instance integration) and
 * cross-instance.test.ts (two-instance integration over a fake Redis
 * bus).
 *
 * Each test asserts ONE thing about ONE branch so a regression
 * points at a single failing case.
 */

function silentLog(): FastifyBaseLogger {
  // Returning a sub-logger that no-ops everything. Fastify's logger
  // interface is wider than we need but the call-router only uses
  // `.warn()`; the rest is here to satisfy the type.
  const noop = () => {
    /* intentional */
  };
  // The .child() return type recurses; using `as` keeps the cast contained.
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    level: 'silent',
    silent: noop,
    child() {
      return silentLog();
    },
  } as unknown as FastifyBaseLogger;
}

function fakeSocket(): WebSocket {
  // userNotifier.deliverLocally calls socket.send — we don't assert
  // on it directly in these tests (notify-was-called is what matters),
  // so just return a stub.
  return { send: vi.fn(), readyState: 1 } as unknown as WebSocket;
}

interface MockNotifier {
  notify: ReturnType<typeof vi.fn>;
}

function buildDeps(opts?: {
  localPeerOf?: { userId: string; deviceToken: string };
  presenceInstance?: string;
}): CallRouterDeps & { _push: MockPushProvider; _notifier: MockNotifier } {
  const connections = new InMemoryConnections();
  if (opts?.localPeerOf) {
    void connections.add(
      opts.localPeerOf.userId,
      opts.localPeerOf.deviceToken,
      fakeSocket(),
    );
  }
  const presence = new InMemoryPresence();
  if (opts?.presenceInstance) {
    // recordOnline marks the user as authed on a given instance.
    void presence.recordOnline('bob', opts.presenceInstance);
  }
  const push = new MockPushProvider();
  const notifier: MockNotifier = { notify: vi.fn() };
  const callBuffer = createCallOfferBuffer();
  return {
    connections,
    presence,
    instanceId: 'A',
    userNotifier: notifier as unknown as CallRouterDeps['userNotifier'],
    callBuffer,
    push,
    log: silentLog(),
    _push: push,
    _notifier: notifier,
  };
}

const CALL_ID = 'call-01HXYZAAAAAAAAAAAAAAAAAAAA';
const CIPHERTEXT = 'T0ZGRVI=';

describe('routeCallFrame — validation', () => {
  it('rejects when `to` is missing', async () => {
    const deps = buildDeps();
    const result = await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: '' as string,
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    expect(result).toEqual({
      ok: false,
      code: 'invalid_target',
      message: 'call frame requires `to`',
    });
  });

  it('rejects when sender == recipient', async () => {
    const deps = buildDeps();
    const result = await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'alice',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('invalid_target');
    expect(result.ok === false && result.message).toMatch(/cannot call self/);
  });

  it('rejects when call_id is missing', async () => {
    const deps = buildDeps();
    const result = await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: '' as string,
      ciphertext: CIPHERTEXT,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('bad_call_id');
  });

  it('rejects offer/answer/ice when ciphertext is missing', async () => {
    const deps = buildDeps();
    for (const type of ['call_offer', 'call_answer', 'call_ice'] as const) {
      const result = await routeCallFrame(deps, 'alice', {
        type,
        to: 'bob',
        call_id: CALL_ID,
        ciphertext: undefined as unknown as string,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.code).toBe('invalid_ciphertext');
    }
  });

  it('accepts call_end without ciphertext', async () => {
    const deps = buildDeps();
    const result = await routeCallFrame(deps, 'alice', {
      type: 'call_end',
      to: 'bob',
      call_id: CALL_ID,
      reason: 'cancel',
    });
    expect(result.ok).toBe(true);
  });
});

describe('routeCallFrame — always-push for call_offer (rc.58)', () => {
  it('pushes for call_offer even when the recipient is online locally', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await new Promise((r) => setImmediate(r));
    expect(deps._push.calls).toHaveLength(1);
    expect(deps._push.calls[0]).toMatchObject({
      userId: 'bob',
      kind: 'call',
      senderId: 'alice',
    });
  });

  it('pushes for call_offer even when the recipient is on another instance', async () => {
    const deps = buildDeps({ presenceInstance: 'B' });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await new Promise((r) => setImmediate(r));
    expect(deps._push.calls).toHaveLength(1);
  });

  it('pushes for call_offer when the recipient is truly offline', async () => {
    const deps = buildDeps();
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await new Promise((r) => setImmediate(r));
    expect(deps._push.calls).toHaveLength(1);
  });

  it('does NOT push for call_answer / call_ice / non-cancel call_end', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    for (const type of ['call_answer', 'call_ice'] as const) {
      await routeCallFrame(deps, 'alice', {
        type,
        to: 'bob',
        call_id: CALL_ID,
        ciphertext: CIPHERTEXT,
      });
    }
    await routeCallFrame(deps, 'alice', {
      type: 'call_end',
      to: 'bob',
      call_id: CALL_ID,
      reason: 'hangup',
    });
    await new Promise((r) => setImmediate(r));
    expect(deps._push.calls).toHaveLength(0);
  });
});

describe('routeCallFrame — missed-call push', () => {
  it('pushes a missed-call notification on call_end with reason cancel', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_end',
      to: 'bob',
      call_id: CALL_ID,
      reason: 'cancel',
    });
    await new Promise((r) => setImmediate(r));
    expect(deps._push.calls).toHaveLength(1);
    expect(deps._push.calls[0]).toMatchObject({
      userId: 'bob',
      senderId: 'alice',
      kind: 'call',
      callEvent: 'missed',
    });
  });
});

describe('routeCallFrame — online routing', () => {
  it('uses UserNotifier when recipient is online locally', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({
        type: 'call_offer',
        from: 'alice',
        call_id: CALL_ID,
        ciphertext: CIPHERTEXT,
      }),
    );
  });

  it('uses UserNotifier when recipient is online on another instance', async () => {
    const deps = buildDeps({ presenceInstance: 'B' });
    await routeCallFrame(deps, 'alice', {
      type: 'call_answer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: 'QU5T',
    });
    expect(deps._notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('does NOT buffer the offer when recipient is online (live route wins)', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    expect(await deps.callBuffer.drain('bob')).toEqual([]);
  });

  it('clears the buffer on call_end even when recipient is online', async () => {
    // Seed a stale buffered offer from a prior racing call.
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    deps.callBuffer.put('bob', {
      type: 'call_offer',
      fromUserId: 'alice',
      callId: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_end',
      to: 'bob',
      call_id: CALL_ID,
      reason: 'cancel',
    });
    expect(await deps.callBuffer.drain('bob')).toEqual([]);
  });
});

describe('routeCallFrame — offline routing', () => {
  it('buffers a call_offer when recipient is truly offline', async () => {
    const deps = buildDeps();
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    const buffered = await deps.callBuffer.drain('bob');
    expect(buffered).toEqual([
      {
        type: 'call_offer',
        fromUserId: 'alice',
        callId: CALL_ID,
        ciphertext: CIPHERTEXT,
      },
    ]);
    // UserNotifier should NOT have been called (no devices anywhere).
    expect(deps._notifier.notify).not.toHaveBeenCalled();
  });

  it('buffers trickle call_ice when recipient is offline', async () => {
    const deps = buildDeps();
    // First put an offer so the buffer has an anchor.
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_ice',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: 'SUNF',
    });
    const buffered = await deps.callBuffer.drain('bob');
    expect(buffered).toHaveLength(2);
    expect(buffered[1]).toEqual({
      type: 'call_ice',
      fromUserId: 'alice',
      callId: CALL_ID,
      ciphertext: 'SUNF',
    });
  });

  it('clears buffer on call_end to an offline peer (no stale ring on reconnect)', async () => {
    const deps = buildDeps();
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_end',
      to: 'bob',
      call_id: CALL_ID,
      reason: 'cancel',
    });
    expect(await deps.callBuffer.drain('bob')).toEqual([]);
  });

  it('drops call_answer to an offline peer silently (no buffer, no notify)', async () => {
    const deps = buildDeps();
    await routeCallFrame(deps, 'alice', {
      type: 'call_answer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: 'QU5T',
    });
    expect(deps._notifier.notify).not.toHaveBeenCalled();
    expect(await deps.callBuffer.drain('bob')).toEqual([]);
  });
});
