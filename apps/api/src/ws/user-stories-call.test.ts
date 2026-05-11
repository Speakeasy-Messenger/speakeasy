import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type AddressInfo } from 'ws';
import { MockValidator } from '@speakeasy/vouchflow';
// @ts-expect-error - ioredis-mock has no types but is API-compatible with ioredis
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryConnections } from './connections.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';
import { InMemoryDevicesRepo } from '../db/devices.memory.js';
import { InMemoryGroupRepo } from '../db/groups.memory.js';
import { InMemoryCommunityRepo } from '../db/communities.memory.js';
import { MockPushProvider } from '../push/push.mock.js';
import { RedisAckRouter } from './ack-router.redis.js';
import { RedisUserNotifier } from './user-notifier.redis.js';
import { createRedisCallOfferBuffer } from './call-offer-buffer.redis.js';
import { RedisPresence } from '../presence/redis.js';

/**
 * Tier B end-to-end tests for the user-visible call signaling
 * behaviors. Same harness as cross-instance-real-redis.test.ts:
 * real `buildServer`, real `Redis*` classes against ioredis-mock,
 * real `ws` WebSocket. The point is to exercise the production
 * code paths in the configuration that matches the 2-instance
 * fly deploy.
 *
 * Stories covered (numbered as in the QA brief):
 *  1.  Call wake-up flow (push + buffer → reconnect drain → accept)
 *  2.  Cross-instance call full lifecycle
 *  3.  Rapid reconnect during call
 *  4.  call_end clears stale buffered offer
 *  5.  Multi-device call fan-out
 *  6.  Always-push for call_offer (rc.58)
 *  14. Offer buffer TTL (>30s)
 *  15. call_answer to offline peer drops silently
 *  18. Reject call to self
 *  19. Reject malformed call frames
 */

function makeMockRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

class MsgQueue {
  private readonly queued: unknown[] = [];
  private readonly waiters: Array<(m: unknown) => void> = [];
  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queued.push(msg);
    });
  }
  next(timeoutMs = 3000): Promise<unknown> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('MsgQueue.next timeout')),
        timeoutMs,
      );
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
}

/**
 * Multi-token validator: the default `dvt_<userId>` mapping plus an
 * override map for per-device tokens that share a userId. Needed for
 * multi-device fan-out stories.
 */
function makeValidator(perTokenUserId?: Record<string, string>): MockValidator {
  return new MockValidator((tok) => {
    if (!tok.startsWith('dvt_')) return { ok: false, reason: 'device_not_found' };
    const override = perTokenUserId?.[tok];
    if (override) {
      return { ok: true, attestation: { confidence: 'medium', userId: override } };
    }
    return {
      ok: true,
      attestation: { confidence: 'medium', userId: tok.slice('dvt_'.length) },
    };
  });
}

interface Cluster {
  appA: Awaited<ReturnType<typeof buildServer>>;
  appB: Awaited<ReturnType<typeof buildServer>>;
  urlA: string;
  urlB: string;
  pushA: MockPushProvider;
  pushB: MockPushProvider;
  callBufferRedisA: Redis;
  close: () => Promise<void>;
}

async function buildCluster(opts?: {
  perTokenUserId?: Record<string, string>;
  callBufferTtlMs?: number;
}): Promise<Cluster> {
  const validator = makeValidator(opts?.perTokenUserId);

  // Shared cluster-wide repos (production analog: shared Postgres).
  const users = new InMemoryUserRepo();
  const messages = new InMemoryMessagesRepo();
  const devices = new InMemoryDevicesRepo();
  const groups = new InMemoryGroupRepo();
  const communities = new InMemoryCommunityRepo();

  // Two ioredis-mock instances sharing in-memory state.
  const presenceRedisA = makeMockRedis();
  const presenceRedisB = makeMockRedis();
  const presenceA = new RedisPresence(presenceRedisA);
  const presenceB = new RedisPresence(presenceRedisB);

  const callBufferRedisA = makeMockRedis();
  const callBufferRedisB = makeMockRedis();
  const callBufferA = createRedisCallOfferBuffer(callBufferRedisA, {
    ttlMs: opts?.callBufferTtlMs,
  });
  const callBufferB = createRedisCallOfferBuffer(callBufferRedisB, {
    ttlMs: opts?.callBufferTtlMs,
  });

  // Per-instance connections.
  const connsA = new InMemoryConnections();
  const connsB = new InMemoryConnections();

  const pushA = new MockPushProvider();
  const pushB = new MockPushProvider();

  const ackPubA = makeMockRedis();
  const ackSubA = makeMockRedis();
  const ackPubB = makeMockRedis();
  const ackSubB = makeMockRedis();
  const ackA = new RedisAckRouter(ackPubA, ackSubA);
  const ackB = new RedisAckRouter(ackPubB, ackSubB);

  const notifyPubA = makeMockRedis();
  const notifySubA = makeMockRedis();
  const notifyPubB = makeMockRedis();
  const notifySubB = makeMockRedis();
  const userNotifierA = new RedisUserNotifier(connsA, notifyPubA, notifySubA, 'A');
  const userNotifierB = new RedisUserNotifier(connsB, notifyPubB, notifySubB, 'B');

  const appA = await buildServer({
    validator,
    userRepo: users,
    messagesRepo: messages,
    devicesRepo: devices,
    groupRepo: groups,
    communityRepo: communities,
    connections: connsA,
    presence: presenceA,
    push: pushA,
    ackRouter: ackA,
    userNotifier: userNotifierA,
    callBuffer: callBufferA,
    instanceId: 'A',
    logger: false,
  });
  const appB = await buildServer({
    validator,
    userRepo: users,
    messagesRepo: messages,
    devicesRepo: devices,
    groupRepo: groups,
    communityRepo: communities,
    connections: connsB,
    presence: presenceB,
    push: pushB,
    ackRouter: ackB,
    userNotifier: userNotifierB,
    callBuffer: callBufferB,
    instanceId: 'B',
    logger: false,
  });

  await appA.listen({ port: 0, host: '127.0.0.1' });
  await appB.listen({ port: 0, host: '127.0.0.1' });
  const urlA = `ws://127.0.0.1:${(appA.server.address() as AddressInfo).port}/ws`;
  const urlB = `ws://127.0.0.1:${(appB.server.address() as AddressInfo).port}/ws`;

  return {
    appA,
    appB,
    urlA,
    urlB,
    pushA,
    pushB,
    callBufferRedisA,
    close: async () => {
      await appA.close();
      await appB.close();
    },
  };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function authedSocket(
  url: string,
  token: string,
): Promise<{ ws: WebSocket; q: MsgQueue; userId: string }> {
  const ws = await open(url);
  const q = new MsgQueue(ws);
  ws.send(JSON.stringify({ type: 'auth', token }));
  const authed = (await q.next()) as { type: string; user_id: string };
  expect(authed.type).toBe('authed');
  return { ws, q, userId: authed.user_id };
}

describe('user-story call signaling (Tier B, ioredis-mock)', () => {
  let cluster: Cluster;
  const sockets = new Set<WebSocket>();

  beforeEach(async () => {
    cluster = await buildCluster();
  });

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.terminate();
      }
    }
    sockets.clear();
    await cluster.close();
  });

  function track(ws: WebSocket): WebSocket {
    sockets.add(ws);
    return ws;
  }

  // ---- Story 1: full incoming-call-via-push flow ---------------------
  it('story 1: offline callee → push fires → callee comes online → drains offer → accepts → caller gets answer', async () => {
    // Alice on instance A.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    await new Promise((r) => setTimeout(r, 30));

    // Alice calls Bob — Bob has never connected (truly offline).
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY1AAAAAAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );

    // Push must fire (rc.58: always-push for call_offer). It fires on
    // the instance that handled the offer — that's A.
    await new Promise((r) => setTimeout(r, 50));
    expect(cluster.pushA.calls).toHaveLength(1);
    expect(cluster.pushA.calls[0]).toMatchObject({
      userId: 'bob',
      kind: 'call',
      senderId: 'alice',
    });

    // Bob comes online on instance B (different instance than A).
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    // Buffer drain runs after the `authed` frame. Pull frames until
    // we see the offer (or time out).
    const offer = (await bob.q.next()) as {
      type: string;
      from: string;
      call_id: string;
      ciphertext: string;
    };
    expect(offer.type).toBe('call_offer');
    expect(offer.from).toBe('alice');
    expect(offer.call_id).toBe('call-01HXSTORY1AAAAAAAAAAAAAAAA');
    expect(offer.ciphertext).toBe('T0ZGRVI=');

    // Bob accepts. Cross-instance answer must reach Alice on A.
    bob.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXSTORY1AAAAAAAAAAAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
    };
    expect(answer.type).toBe('call_answer');
    expect(answer.from).toBe('bob');
    expect(answer.ciphertext).toBe('QU5T');
  });

  // ---- Story 2: full cross-instance call lifecycle -------------------
  it('story 2: offer → answer → ICE both directions → call_end across instances', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    await new Promise((r) => setTimeout(r, 50));

    const callId = 'call-01HXSTORY2LIFECYCLEAAAAAA';

    // Offer A→B.
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: callId,
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const offer = (await bob.q.next()) as { type: string; from: string };
    expect(offer.type).toBe('call_offer');
    expect(offer.from).toBe('alice');

    // Answer B→A.
    bob.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: callId,
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as { type: string };
    expect(answer.type).toBe('call_answer');

    // Trickle ICE A→B.
    alice.ws.send(
      JSON.stringify({
        type: 'call_ice',
        to: 'bob',
        call_id: callId,
        ciphertext: 'SUNFQQ==',
      }),
    );
    const iceToBob = (await bob.q.next()) as { type: string; ciphertext: string };
    expect(iceToBob.type).toBe('call_ice');
    expect(iceToBob.ciphertext).toBe('SUNFQQ==');

    // Trickle ICE B→A.
    bob.ws.send(
      JSON.stringify({
        type: 'call_ice',
        to: 'alice',
        call_id: callId,
        ciphertext: 'SUNFQg==',
      }),
    );
    const iceToAlice = (await alice.q.next()) as { type: string; ciphertext: string };
    expect(iceToAlice.type).toBe('call_ice');
    expect(iceToAlice.ciphertext).toBe('SUNFQg==');

    // Caller hangs up. End reaches Bob on B.
    alice.ws.send(
      JSON.stringify({
        type: 'call_end',
        to: 'bob',
        call_id: callId,
        reason: 'hangup',
      }),
    );
    const end = (await bob.q.next()) as { type: string; reason: string; from: string };
    expect(end.type).toBe('call_end');
    expect(end.reason).toBe('hangup');
    expect(end.from).toBe('alice');
  });

  // ---- Story 3: rapid reconnect during call --------------------------
  it('story 3: callee WS closes + reauths within 50ms, then call_offer reaches the new WS', async () => {
    // Bob auths on B, then briefly bounces (mobile backgrounded →
    // foregrounded). Presence must not have wiped Bob between events,
    // and the new WS must receive the subsequent offer.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob1 = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob1.ws);
    await new Promise((r) => setTimeout(r, 50));

    bob1.ws.close();
    await new Promise((r) => setTimeout(r, 50));

    const bob2 = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob2.ws);
    await new Promise((r) => setTimeout(r, 50));

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY3RAPIDAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const offer = (await bob2.q.next()) as { type: string; from: string };
    expect(offer.type).toBe('call_offer');
    expect(offer.from).toBe('alice');

    // Bob answers; alice receives.
    bob2.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXSTORY3RAPIDAAAAAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as { type: string; from: string };
    expect(answer.type).toBe('call_answer');
    expect(answer.from).toBe('bob');
  });

  // ---- Story 4: call_end clears stale buffered offer -----------------
  it('story 4: caller hangs up before offline callee comes online → no phantom ring', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    // Bob is offline. Alice sends offer → buffered.
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY4STALEEEEEEEEEEE',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Alice gives up before Bob reconnects.
    alice.ws.send(
      JSON.stringify({
        type: 'call_end',
        to: 'bob',
        call_id: 'call-01HXSTORY4STALEEEEEEEEEEE',
        reason: 'cancel',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Bob comes online — should NOT receive any call frames.
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    await expect(bob.q.next(200)).rejects.toThrow(/timeout/);
  });

  // ---- Story 5: multi-device call fan-out ----------------------------
  it('story 5: two devices for the callee, both receive the offer; either may answer', async () => {
    await cluster.close();
    cluster = await buildCluster({
      perTokenUserId: {
        dvt_alice: 'alice',
        dvt_bob_phone: 'bob',
        dvt_bob_laptop: 'bob',
      },
    });

    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    // Phone on B, laptop on A — exercise both local + cross-instance fan-out.
    const phone = await authedSocket(cluster.urlB, 'dvt_bob_phone');
    track(phone.ws);
    const laptop = await authedSocket(cluster.urlA, 'dvt_bob_laptop');
    track(laptop.ws);
    await new Promise((r) => setTimeout(r, 50));

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY5FANOUTAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );

    const onPhone = (await phone.q.next()) as { type: string };
    const onLaptop = (await laptop.q.next()) as { type: string };
    expect(onPhone.type).toBe('call_offer');
    expect(onLaptop.type).toBe('call_offer');

    // Phone answers — Alice gets it.
    phone.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXSTORY5FANOUTAAAAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as { type: string; from: string };
    expect(answer.type).toBe('call_answer');
    expect(answer.from).toBe('bob');

    // Laptop sends call_end (e.g. user dismissed on the other device).
    // Both Alice and Phone should observe end frames addressed to them.
    laptop.ws.send(
      JSON.stringify({
        type: 'call_end',
        to: 'alice',
        call_id: 'call-01HXSTORY5FANOUTAAAAAAAAA',
        reason: 'hangup',
      }),
    );
    const endToAlice = (await alice.q.next()) as { type: string; reason: string };
    expect(endToAlice.type).toBe('call_end');
    expect(endToAlice.reason).toBe('hangup');
  });

  // ---- Story 6: always-push for call_offer (rc.58) -------------------
  it('story 6: call_offer to a fully-online callee still produces a push.notifyDelivery with kind=call', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    await new Promise((r) => setTimeout(r, 50));

    const beforeA = cluster.pushA.calls.length;

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY6ALWAYSPUSHFFFFFF',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    // Wait for the live offer + the fire-and-forget push.
    const offer = (await bob.q.next()) as { type: string };
    expect(offer.type).toBe('call_offer');
    await new Promise((r) => setTimeout(r, 50));

    // The push is fired by the instance that received the call_offer
    // frame — that's A (alice's instance). Bob being online on B does
    // not suppress the push (rc.58 behavior).
    expect(cluster.pushA.calls.length).toBe(beforeA + 1);
    expect(cluster.pushA.calls.at(-1)).toMatchObject({
      userId: 'bob',
      kind: 'call',
      senderId: 'alice',
    });
  });

  // ---- Story 14: offer-buffer TTL ------------------------------------
  it('story 14: buffered offer expires after TTL → callee comes online later → no offer drained', async () => {
    // Use a short TTL via the helper, so we don't need fake-timer
    // gymnastics against ioredis-mock's PX. ioredis-mock honours PX
    // for getdel — verified by the existing call-offer-buffer.redis.test.ts.
    await cluster.close();
    cluster = await buildCluster({ callBufferTtlMs: 100 });

    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY14TTLAAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Confirm a buffer entry exists (sanity).
    const beforeExpiry = await cluster.callBufferRedisA.get(
      'speakeasy:call-buf:bob',
    );
    expect(beforeExpiry).not.toBeNull();

    // Wait past the TTL.
    await new Promise((r) => setTimeout(r, 200));

    // Bob comes online. Drain should yield nothing.
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    await expect(bob.q.next(200)).rejects.toThrow(/timeout/);
  });

  // ---- Story 15: call_answer to fully-offline peer drops silently ----
  it('story 15: call_answer to an offline peer is a silent no-op (no error, nothing buffered)', async () => {
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);

    bob.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'ghost-user',
        call_id: 'call-01HXSTORY15DROPGHOSTAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    // No error frame returned.
    await expect(bob.q.next(200)).rejects.toThrow(/timeout/);

    // Nothing buffered — the call-router intentionally does NOT
    // buffer call_answer (mid-call signaling, the caller's local
    // ringing-window timeout produces the same outcome).
    const buffered = await cluster.callBufferRedisA.get(
      'speakeasy:call-buf:ghost-user',
    );
    expect(buffered).toBeNull();
  });

  // ---- Story 18: reject call_offer to self ---------------------------
  it('story 18: call_offer with to === self → invalid_target', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'alice',
        call_id: 'call-01HXSTORY18SELFAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const err = (await alice.q.next()) as { type: string; code: string };
    expect(err.type).toBe('error');
    expect(err.code).toBe('invalid_target');
  });

  // ---- Story 19: reject malformed call frames ------------------------
  it('story 19: malformed call frames return the right error codes', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    // Missing `to`.
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: '',
        call_id: 'call-01HXSTORY19BADAAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const err1 = (await alice.q.next()) as { type: string; code: string };
    expect(err1.type).toBe('error');
    expect(err1.code).toBe('invalid_target');

    // Missing call_id.
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        // call_id missing
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const err2 = (await alice.q.next()) as { type: string; code: string };
    expect(err2.code).toBe('bad_call_id');

    // Missing ciphertext on a non-end frame.
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY19BADAAAAAAAAAAAA',
        // ciphertext missing
      }),
    );
    const err3 = (await alice.q.next()) as { type: string; code: string };
    expect(err3.code).toBe('invalid_ciphertext');

    // call_answer to self.
    alice.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXSTORY19BADAAAAAAAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const err4 = (await alice.q.next()) as { type: string; code: string };
    expect(err4.code).toBe('invalid_target');
  });
});
