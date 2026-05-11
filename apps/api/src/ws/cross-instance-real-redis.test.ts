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
 * Cross-instance call signaling against an **ioredis-mock** instead of
 * the hand-rolled `FakeRedisChannel` in cross-instance.test.ts.
 *
 * ioredis-mock is a much closer simulation of the actual ioredis
 * client: it implements pub/sub via internal event-emitter semantics,
 * GETDEL behavior, Lua EVAL, etc. Two FakeRedisChannel-based clients
 * share a literal Set of subscribers; ioredis-mock's clients exchange
 * messages through a shared in-process Redis emulation.
 *
 * Goal: reproduce the production "call_answer doesn't reach caller"
 * bug locally so we can iterate against it deterministically. The
 * existing cross-instance.test.ts using FakeRedisChannel passes
 * cleanly, so any divergence between that and ioredis-mock is
 * exactly the surface we want to inspect.
 *
 * If this ALSO passes, the bug is something only real Upstash +
 * cross-machine network exhibit, and we escalate to a real-Redis
 * harness or a virtual-user CLI against prod.
 */

// All RedisMock instances created within the same Node process that
// pass `{}` as args see the same in-memory store. That's exactly the
// behavior we want — each "fly machine" gets its own client, but
// they share the underlying Redis state.
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

interface Cluster {
  appA: Awaited<ReturnType<typeof buildServer>>;
  appB: Awaited<ReturnType<typeof buildServer>>;
  urlA: string;
  urlB: string;
  close: () => Promise<void>;
}

async function buildCluster(): Promise<Cluster> {
  const validator = new MockValidator((tok) => {
    if (!tok.startsWith('dvt_')) return { ok: false, reason: 'device_not_found' };
    return {
      ok: true,
      attestation: { confidence: 'medium', userId: tok.slice('dvt_'.length) },
    };
  });

  // Shared repos (production analog: shared Postgres).
  const users = new InMemoryUserRepo();
  const messages = new InMemoryMessagesRepo();
  const devices = new InMemoryDevicesRepo();
  const groups = new InMemoryGroupRepo();
  const communities = new InMemoryCommunityRepo();

  // Two ioredis-mock instances sharing in-memory state — production
  // analog: each fly machine has its own ioredis client connecting to
  // the same Upstash.
  const presenceRedisA = makeMockRedis();
  const presenceRedisB = makeMockRedis();
  const presenceA = new RedisPresence(presenceRedisA);
  const presenceB = new RedisPresence(presenceRedisB);

  const callBufferRedisA = makeMockRedis();
  const callBufferRedisB = makeMockRedis();
  const callBufferA = createRedisCallOfferBuffer(callBufferRedisA);
  const callBufferB = createRedisCallOfferBuffer(callBufferRedisB);

  // Per-instance connections (only the local fly machine has the WS).
  const connsA = new InMemoryConnections();
  const connsB = new InMemoryConnections();

  const pushA = new MockPushProvider();
  const pushB = new MockPushProvider();

  // Two ioredis-mock pairs for ack-router pub/sub (per-instance pub/sub
  // pair — RedisAckRouter takes two connections because ioredis can't
  // share one between subscribe and other commands).
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
  userId: string,
): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = await open(url);
  const q = new MsgQueue(ws);
  ws.send(JSON.stringify({ type: 'auth', token: `dvt_${userId}` }));
  const authed = (await q.next()) as { type: string };
  expect(authed.type).toBe('authed');
  return { ws, q };
}

describe('cross-instance call signaling against ioredis-mock', () => {
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

  it('routes call_answer from callee on B to caller on A (the prod bug)', async () => {
    // The exact prod scenario: alice (caller) on A, bob (callee) on B.
    // alice sends call_offer → bob should receive it. bob sends
    // call_answer → alice should receive it. The latter step is where
    // prod fails.
    const alice = await authedSocket(cluster.urlA, 'alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlB, 'bob');
    track(bob.ws);

    // Give presence a moment to record the auths (recordOnline is
    // async and goes through real ioredis-mock now).
    await new Promise((r) => setTimeout(r, 50));

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXIOFFERAAAAAAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const offer = (await bob.q.next()) as {
      type: string;
      from: string;
      call_id: string;
    };
    expect(offer.type).toBe('call_offer');

    bob.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXIOFFERAAAAAAAAAAAAAAAA',
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

  it('survives a callee WS reconnect mid-call (presence race)', async () => {
    // The pattern from tester6's diag: callee briefly backgrounds,
    // WS closes (recordOffline → DELETE session:bob), then quickly
    // foregrounds and reconnects (recordOnline → SET session:bob).
    // If the recordOffline runs AFTER the recordOnline due to async
    // ordering, presence stays cleared and subsequent call_answer
    // routing falls into the offline_drop branch.
    const alice = await authedSocket(cluster.urlA, 'alice');
    track(alice.ws);

    // Bob authes, sees offer, then his WS bounces.
    const bob1 = await authedSocket(cluster.urlB, 'bob');
    track(bob1.ws);
    await new Promise((r) => setTimeout(r, 50));

    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXIRACEAAAAAAAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    await bob1.q.next();

    // Bob's app backgrounds: WS closes.
    bob1.ws.close();
    await new Promise((r) => setTimeout(r, 30));

    // Bob's app foregrounds: new WS auths.
    const bob2 = await authedSocket(cluster.urlB, 'bob');
    track(bob2.ws);
    await new Promise((r) => setTimeout(r, 50));

    // Bob (on bob2) sends call_answer. Alice should receive it.
    bob2.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXIRACEAAAAAAAAAAAAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as {
      type: string;
      ciphertext: string;
    };
    expect(answer.type).toBe('call_answer');
    expect(answer.ciphertext).toBe('QU5T');
  });

  it('survives the reverse race: new auth completes before old close handler runs', async () => {
    // Worst-case race: bob1's close handler runs AFTER bob2's auth
    // handler. In handler.ts the close handler unconditionally
    // recordOffline()s, which can wipe presence even though bob2's
    // session is still live. If this happens, the next call_answer
    // bob sends would hit the offline_drop branch.
    //
    // We can't easily orchestrate the exact race ordering here, but
    // we can verify the OUTCOME is correct: after a rapid close +
    // reauth, presence ultimately reflects "bob is on B".
    const alice = await authedSocket(cluster.urlA, 'alice');
    track(alice.ws);
    const bob1 = await authedSocket(cluster.urlB, 'bob');
    track(bob1.ws);
    // Open a second bob WS BEFORE bob1 fully closes — multi-connect
    // (simulates a rapid foreground-while-WS-still-open).
    const bob2 = await authedSocket(cluster.urlB, 'bob');
    track(bob2.ws);
    bob1.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // Now alice calls. The offer should reach bob (via bob2).
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXIRACE2AAAAAAAAAAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const offer = (await bob2.q.next()) as { type: string };
    expect(offer.type).toBe('call_offer');

    // And bob's answer should reach alice.
    bob2.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXIRACE2AAAAAAAAAAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as { type: string };
    expect(answer.type).toBe('call_answer');
  });
});
