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
  /**
   * Phase 5j Private Call — declared capability for `localPeerOf`. When
   * supplying multiple devices for the same user, use `extraLocalPeers`
   * (each can carry its own capability set). Default `['audio','video']`
   * matches the pre-rc.130 historical capability set.
   */
  localPeerCapabilities?: readonly ('audio' | 'video' | 'private')[];
  extraLocalPeers?: Array<{
    userId: string;
    deviceToken: string;
    capabilities?: readonly ('audio' | 'video' | 'private')[];
  }>;
  /** User ids whose "Refuse video calls" flag is on (#13). */
  refuseVideoFor?: readonly string[];
}): CallRouterDeps & { _push: MockPushProvider; _notifier: MockNotifier } {
  const connections = new InMemoryConnections();
  if (opts?.localPeerOf) {
    void connections.add(
      opts.localPeerOf.userId,
      opts.localPeerOf.deviceToken,
      fakeSocket(),
      opts.localPeerCapabilities,
    );
  }
  if (opts?.extraLocalPeers) {
    for (const peer of opts.extraLocalPeers) {
      void connections.add(
        peer.userId,
        peer.deviceToken,
        fakeSocket(),
        peer.capabilities,
      );
    }
  }
  const presence = new InMemoryPresence();
  if (opts?.presenceInstance) {
    // recordOnline marks the user as authed on a given instance.
    void presence.recordOnline('bob', opts.presenceInstance);
  }
  const push = new MockPushProvider();
  const notifier: MockNotifier = { notify: vi.fn() };
  const callBuffer = createCallOfferBuffer();
  const refuse = new Set(opts?.refuseVideoFor ?? []);
  const users = {
    findById: vi.fn(async (id: string) => ({ id, refuseVideo: refuse.has(id) })),
  } as unknown as CallRouterDeps['users'];
  return {
    connections,
    presence,
    instanceId: 'A',
    userNotifier: notifier as unknown as CallRouterDeps['userNotifier'],
    callBuffer,
    push,
    log: silentLog(),
    users,
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
    // Server fans out with the normalized plaintext `kind` hint; absent
    // ⇒ defaults to 'audio'. Post-#13 there is NO third NotifyOptions
    // argument — the capability gate was removed (masking is caller-local).
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({
        type: 'call_offer',
        from: 'alice',
        call_id: CALL_ID,
        ciphertext: CIPHERTEXT,
        kind: 'audio',
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

  it('buffers the offer as a safety net even when the recipient appears online', async () => {
    // Presence can be stale for a few seconds after a background
    // disconnect; a live notify to a now-dead socket is silently dropped.
    // The buffer must still hold the offer so the callee's reconnect drain
    // recovers it (chloro 2026-06-04: tapped call notif → chat, no ring).
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    // Live route still fires...
    expect(deps._notifier.notify).toHaveBeenCalledTimes(1);
    // ...AND the offer is buffered for the reconnect-drain safety net.
    expect(await deps.callBuffer.drain('bob')).toEqual([
      { type: 'call_offer', fromUserId: 'alice', callId: CALL_ID, ciphertext: CIPHERTEXT },
    ]);
  });

  it('clears the buffered offer when the callee answers (no phantom re-ring)', async () => {
    // Seed a buffered offer for bob (the callee), then bob answers. The
    // answer flows bob→alice, so the callee whose buffer must be cleared
    // is the SENDER of the answer, not `to`.
    const deps = buildDeps({ presenceInstance: 'B' });
    deps.callBuffer.put('bob', {
      type: 'call_offer',
      fromUserId: 'alice',
      callId: CALL_ID,
      ciphertext: CIPHERTEXT,
    });
    await routeCallFrame(deps, 'bob', {
      type: 'call_answer',
      to: 'alice',
      call_id: CALL_ID,
      ciphertext: 'QU5T',
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

/**
 * #13 unified call entry — masking is caller-local, so the OLD
 * `requireCapability:'private'` fan-out gate was REMOVED. A masked
 * ('private') offer must now ring ALL of the callee's devices, old and
 * new: a device that can't render the animal UI falls back to a plain
 * audio call and still hears the caller's masked voice. These tests are
 * the rewritten regression guard for that gate removal — they assert the
 * router no longer passes any `requireCapability` option to notify.
 */
describe('routeCallFrame — masked offer rings all devices (no capability gate)', () => {
  it("kind:'private' rings the peer with NO requireCapability option", async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_capable' },
      localPeerCapabilities: ['audio', 'video', 'private'],
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'private',
    });
    // Exactly two args — no third `requireCapability` argument.
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ type: 'call_offer', from: 'alice', kind: 'private' }),
    );
    expect(deps._notifier.notify.mock.calls[0]).toHaveLength(2);
  });

  it("kind:'audio' rings with no requireCapability option", async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_phone' },
      localPeerCapabilities: ['audio', 'video'],
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'audio',
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ type: 'call_offer', kind: 'audio' }),
    );
    expect(deps._notifier.notify.mock.calls[0]).toHaveLength(2);
  });

  it('unknown kind on the wire is coerced to audio (defense in depth)', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'foo' as 'audio',
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ kind: 'audio' }),
    );
  });

  it('a masked offer reaches a peer signed in on BOTH an old and new device', async () => {
    // Post-#13: the old phone (no 'private' capability) must ALSO ring —
    // it falls back to plain audio and still hears the masked voice. The
    // gate that previously filtered it out is gone, so the router rings
    // the user (all devices) and passes no capability filter.
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob_old' },
      localPeerCapabilities: ['audio', 'video'],
      extraLocalPeers: [
        {
          userId: 'bob',
          deviceToken: 'dvt_bob_new',
          capabilities: ['audio', 'video', 'private'],
        },
      ],
    });
    expect(deps.connections.getDevices('bob').length).toBe(2);
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'private',
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ kind: 'private' }),
    );
    expect(deps._notifier.notify.mock.calls[0]).toHaveLength(2);
  });
});

/**
 * #13 — "Refuse video calls". A video offer to a user who refuses video
 * is rejected at the router BEFORE any ring/push/buffer: the caller gets
 * a `video_refused` call_end; the callee sees nothing. Audio + masked
 * ('private') offers are never gated by it.
 */
describe('routeCallFrame — refuse-video gate', () => {
  it('rejects a video offer to a refusing callee: caller gets video_refused, callee untouched', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob' },
      refuseVideoFor: ['bob'],
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'video',
    });
    // Caller (alice) is told video_refused.
    expect(deps._notifier.notify).toHaveBeenCalledWith('alice', {
      type: 'call_end',
      from: 'bob',
      call_id: CALL_ID,
      reason: 'video_refused',
    });
    // The callee (bob) is never rung, pushed, or buffered.
    expect(deps._notifier.notify).not.toHaveBeenCalledWith(
      'bob',
      expect.anything(),
    );
    expect(deps._push.calls).toHaveLength(0);
    expect(await deps.callBuffer.drain('bob')).toEqual([]);
  });

  it('does NOT gate an audio offer to a video-refusing callee', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob' },
      refuseVideoFor: ['bob'],
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'audio',
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ kind: 'audio' }),
    );
  });

  it('does NOT gate a masked (private) offer to a video-refusing callee', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob' },
      refuseVideoFor: ['bob'],
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'private',
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ kind: 'private' }),
    );
  });

  it('lets a video offer through to a callee who does NOT refuse video', async () => {
    const deps = buildDeps({
      localPeerOf: { userId: 'bob', deviceToken: 'dvt_bob' },
    });
    await routeCallFrame(deps, 'alice', {
      type: 'call_offer',
      to: 'bob',
      call_id: CALL_ID,
      ciphertext: CIPHERTEXT,
      kind: 'video',
    });
    expect(deps._notifier.notify).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({ kind: 'video' }),
    );
  });
});
