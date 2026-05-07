import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, AddressInfo } from 'ws';
import type { Redis } from 'ioredis';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryConnections } from './connections.js';
import { InMemoryPresence } from '../presence/memory.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';
import { InMemoryDevicesRepo } from '../db/devices.memory.js';
import { InMemoryGroupRepo } from '../db/groups.memory.js';
import { InMemoryCommunityRepo } from '../db/communities.memory.js';
import { MockPushProvider } from '../push/push.mock.js';
import { RedisAckRouter } from './ack-router.redis.js';

/**
 * Phase 5f WebSocket production-class test: spin up TWO `buildServer`
 * instances backed by a SHARED message buffer + shared user/device
 * state, with their AckRouters wired to a single (fake) Redis pub/sub
 * bus. This is the same shape a Fly two-instance deploy presents:
 * each machine has its own `Connections` pool, both share Postgres
 * and Redis.
 *
 * Scenario under test (the spec's "cross-instance ack routing"):
 *
 *   1. Alice connects to instance A. Bob has never connected.
 *   2. Alice sends a direct message to Bob. Instance A persists it
 *      to the shared buffer, finds no live device for Bob locally,
 *      fires push notify-only.
 *   3. Bob connects to instance B. Instance B's auth handshake runs
 *      `deliverBuffered`, drains Bob's row from the shared buffer,
 *      forwards it to Bob's socket.
 *   4. Bob acks. Instance B's handler calls
 *      `messages.markDeliveredByDevice` → `fully_delivered`, then
 *      announces via the AckRouter (Redis publish).
 *   5. Instance A's AckRouter listener receives the published event,
 *      finds Alice in its local connections, sends her the
 *      `delivered` frame.
 *
 * The first test exercises this for one pair, the second for many
 * concurrent pairs to flush out any race between buffer drain,
 * markDeliveredByDevice, and the cross-instance announce.
 */

const CHANNEL = 'speakeasy:ack';

class FakeRedisChannel {
  private readonly subscribers = new Set<(channel: string, raw: string) => void>();
  publish(channel: string, raw: string): void {
    for (const fn of this.subscribers) fn(channel, raw);
  }
  addMessageHandler(fn: (channel: string, raw: string) => void): void {
    this.subscribers.add(fn);
  }
}

function fakeRedisPair(bus: FakeRedisChannel): { pub: Redis; sub: Redis } {
  let onMessage: ((channel: string, raw: string) => void) | undefined;
  const pub = {
    publish(channel: string, raw: string): Promise<number> {
      bus.publish(channel, raw);
      return Promise.resolve(1);
    },
  } as unknown as Redis;
  const sub = {
    subscribe(_channel: string): Promise<void> {
      if (onMessage) bus.addMessageHandler(onMessage);
      return Promise.resolve();
    },
    on(event: string, handler: (channel: string, raw: string) => void): Redis {
      if (event !== 'message') return sub;
      onMessage = handler;
      bus.addMessageHandler(handler);
      return sub;
    },
    unsubscribe(_channel: string): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as Redis;
  return { pub, sub };
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
  next(timeoutMs = 4000): Promise<unknown> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('MsgQueue.next timeout')), timeoutMs);
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
  shared: {
    users: InMemoryUserRepo;
    messages: InMemoryMessagesRepo;
    devices: InMemoryDevicesRepo;
    groups: InMemoryGroupRepo;
    communities: InMemoryCommunityRepo;
  };
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

  // Shared cluster-wide state. In production these are Postgres tables;
  // here they're a single InMemoryRepo instance reused by both apps.
  const users = new InMemoryUserRepo();
  const messages = new InMemoryMessagesRepo();
  const devices = new InMemoryDevicesRepo();
  const groups = new InMemoryGroupRepo();
  const communities = new InMemoryCommunityRepo();

  // Per-instance state.
  const connsA = new InMemoryConnections();
  const connsB = new InMemoryConnections();
  const presenceA = new InMemoryPresence();
  const presenceB = new InMemoryPresence();
  const pushA = new MockPushProvider();
  const pushB = new MockPushProvider();

  // Shared (fake) Redis pub/sub bus. Both ackRouters publish + subscribe
  // through the same channel.
  const bus = new FakeRedisChannel();
  const pairA = fakeRedisPair(bus);
  const pairB = fakeRedisPair(bus);
  const ackA = new RedisAckRouter(pairA.pub, pairA.sub);
  const ackB = new RedisAckRouter(pairB.pub, pairB.sub);

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
    shared: { users, messages, devices, groups, communities },
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

describe('cross-instance message + ack routing (Phase 5f)', () => {
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

  it('alice on A → message buffered → bob connects to B → bob acks → alice on A gets `delivered`', async () => {
    const alice = await authedSocket(cluster.urlA, 'alice');
    track(alice.ws);

    // Alice sends to Bob. Bob has never connected anywhere; the
    // message is buffered in the shared MessagesRepo with empty
    // targetDevices (legacy single-device shortcut: any ack deletes).
    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'aGVsbG8=',
        msg_type: 'direct',
      }),
    );
    // Wait briefly so the persist completes before Bob auths.
    await new Promise((r) => setTimeout(r, 50));
    expect(cluster.shared.messages.buffer.size).toBe(1);

    // Bob connects to instance B. deliverBuffered drains, forwards.
    const bob = await authedSocket(cluster.urlB, 'bob');
    track(bob.ws);
    const incoming = (await bob.q.next()) as {
      type: string;
      from: string;
      message_id: string;
      ciphertext: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alice');
    expect(incoming.ciphertext).toBe('aGVsbG8=');

    // Bob acks on B. B's handler announces via Redis. A's listener
    // emits `delivered` to Alice.
    bob.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await alice.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(incoming.message_id);
    expect(cluster.shared.messages.buffer.size).toBe(0);
  });

  it('30 concurrent cross-instance pairs all receive `delivered` correctly', async () => {
    const PAIR_COUNT = 30;

    // Open all sender sockets on A.
    const senders = await Promise.all(
      Array.from({ length: PAIR_COUNT }, (_, i) =>
        authedSocket(cluster.urlA, `sender${i}`).then((s) => {
          track(s.ws);
          return s;
        }),
      ),
    );

    // Each sender fires one direct to its paired recipient.
    for (let i = 0; i < PAIR_COUNT; i++) {
      senders[i]!.ws.send(
        JSON.stringify({
          type: 'message',
          to: `recipient${i}`,
          ciphertext: Buffer.from(`payload-${i}`).toString('base64'),
          msg_type: 'direct',
        }),
      );
    }
    // Settle: all rows persisted. The single-process FakeRedis
    // means the publish is synchronous, but the persist is awaited
    // inside the handler — give a beat for all 30 to land.
    await new Promise((r) => setTimeout(r, 100));
    expect(cluster.shared.messages.buffer.size).toBe(PAIR_COUNT);

    // Recipients connect to B in parallel. Each drains its single
    // buffered row, acks. The cross-instance announce should produce
    // a `delivered` on the matching sender's socket.
    const recipients = await Promise.all(
      Array.from({ length: PAIR_COUNT }, (_, i) =>
        authedSocket(cluster.urlB, `recipient${i}`).then((r) => {
          track(r.ws);
          return r;
        }),
      ),
    );

    // For each recipient, drain the buffered message and ack it.
    // Acks fire as soon as drained, in parallel.
    await Promise.all(
      recipients.map(async (recv, i) => {
        const incoming = (await recv.q.next()) as {
          type: string;
          from: string;
          message_id: string;
          ciphertext: string;
        };
        expect(incoming.type).toBe('message');
        expect(incoming.from).toBe(`sender${i}`);
        expect(incoming.ciphertext).toBe(Buffer.from(`payload-${i}`).toString('base64'));
        recv.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
      }),
    );

    // Each sender should now see exactly one `delivered` for its message_id.
    const deliveredFrames = await Promise.all(
      senders.map((s) => s.q.next() as Promise<{ type: string; message_id: string }>),
    );
    for (const ev of deliveredFrames) {
      expect(ev.type).toBe('delivered');
    }
    // No row left in the buffer.
    expect(cluster.shared.messages.buffer.size).toBe(0);
  });
});
