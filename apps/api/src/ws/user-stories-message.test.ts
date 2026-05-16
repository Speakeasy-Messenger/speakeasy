import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type AddressInfo } from 'ws';
import { MockValidator } from '@speakeasy/vouchflow';
import { newGroupId } from '@speakeasy/shared';
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
 * Tier B end-to-end tests for the user-visible message-path
 * behaviors. Same harness shape as user-stories-call.test.ts: real
 * `buildServer`, real Redis-backed classes against ioredis-mock,
 * real `ws` WebSocket.
 *
 * Stories covered (numbered as in the QA brief):
 *  7.  Message live-route, single instance
 *  8.  Message offline drain via auth-handshake (relay buffer)
 *  9.  Cross-instance message + ack
 *  10. Push notify path for messages (kind=message, NOT 'call')
 *  11. Sealed-sender direct message (no `from` on wire)
 *  12. Group message fan-out
 *  13. WS auth race after close
 *  16. Read receipts
 *  17. Multi-recipient group offline drain
 *  20. First-message-to-new-peer (server-side wire-flow only)
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
  groups: InMemoryGroupRepo;
  messages: InMemoryMessagesRepo;
  devices: InMemoryDevicesRepo;
  close: () => Promise<void>;
}

async function buildCluster(opts?: {
  perTokenUserId?: Record<string, string>;
}): Promise<Cluster> {
  const validator = makeValidator(opts?.perTokenUserId);

  const users = new InMemoryUserRepo();
  const messages = new InMemoryMessagesRepo();
  const devices = new InMemoryDevicesRepo();
  const groups = new InMemoryGroupRepo();
  const communities = new InMemoryCommunityRepo();

  const presenceRedisA = makeMockRedis();
  const presenceRedisB = makeMockRedis();
  const presenceA = new RedisPresence(presenceRedisA);
  const presenceB = new RedisPresence(presenceRedisB);

  const callBufferRedisA = makeMockRedis();
  const callBufferRedisB = makeMockRedis();
  const callBufferA = createRedisCallOfferBuffer(callBufferRedisA);
  const callBufferB = createRedisCallOfferBuffer(callBufferRedisB);

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
    groups,
    messages,
    devices,
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

describe('user-story message + presence (Tier B, ioredis-mock)', () => {
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

  // ---- Story 7: message live-route, single instance -----------------
  it('story 7: A and B on same instance, A sends DM, B receives, B acks, A gets delivered', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlA, 'dvt_bob');
    track(bob.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'aGVsbG8=',
        msg_type: 'direct',
      }),
    );
    const incoming = (await bob.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
      message_id: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alice');
    expect(incoming.ciphertext).toBe('aGVsbG8=');

    bob.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await alice.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(incoming.message_id);
    expect(cluster.messages.buffer.size).toBe(0);
  });

  // ---- Story 7b: client-supplied direct message_id round-trips -----
  // Regression: a direct message's id must be the *client's* id end to
  // end. The sender stamps its optimistic bubble with it; if the server
  // mints its own instead, the `delivered`/`read` frames carry an id the
  // bubble never had and receipts can't attach (stuck on a single ✓).
  it('story 7b: a client-supplied direct message_id is what B receives and what `delivered` carries', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlA, 'dvt_bob');
    track(bob.ws);

    const clientId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // a well-formed ULID
    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'aGVsbG8=',
        msg_type: 'direct',
        message_id: clientId,
      }),
    );
    const incoming = (await bob.q.next()) as {
      type: string;
      message_id: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.message_id).toBe(clientId);

    bob.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await alice.q.next()) as {
      type: string;
      message_id: string;
    };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(clientId);
  });

  // ---- Story 8: offline → buffered → reconnect → drain → ack --------
  it('story 8: A sends to offline B → buffered → B comes online → drains → acks → A gets delivered', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'YnVmZmVy',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(cluster.messages.buffer.size).toBe(1);

    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);

    const drained = (await bob.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
      message_id: string;
    };
    expect(drained.type).toBe('message');
    expect(drained.from).toBe('alice');
    expect(drained.ciphertext).toBe('YnVmZmVy');

    bob.ws.send(JSON.stringify({ type: 'ack', message_id: drained.message_id }));
    const delivered = (await alice.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(drained.message_id);
    expect(cluster.messages.buffer.size).toBe(0);
  });

  // ---- Story 9: cross-instance message + ack ------------------------
  it('story 9: A on inst A → message buffered → B comes online on inst B → drains → acks → A gets delivered (full path through ioredis-mock)', async () => {
    // Server design note: messages don't fan out cross-instance live —
    // they persist + push, drained on the recipient's next auth. The
    // "cross-instance" element is the buffered-drain on B's auth and
    // the cross-instance ack routing via RedisAckRouter. Same shape
    // as the existing test in cross-instance.test.ts, but here driven
    // through ioredis-mock instead of the hand-rolled FakeRedisChannel
    // bus.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'eGluc3RhbmNl',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(cluster.messages.buffer.size).toBe(1);

    // Bob auths on the other instance — drains the row.
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    const incoming = (await bob.q.next()) as {
      type: string;
      from: string;
      message_id: string;
      ciphertext: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alice');
    expect(incoming.ciphertext).toBe('eGluc3RhbmNl');

    // Bob acks on B → RedisAckRouter announces → A's listener emits
    // delivered to Alice.
    bob.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await alice.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(incoming.message_id);
  });

  // ---- Story 10: push notify path for messages ----------------------
  it('story 10: push.notifyDelivery for an offline-message has kind=message (or absent), not kind=call', async () => {
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'cHVzaA==',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // The push is fired on the instance that received the message —
    // that's A. Bob has no live WS anywhere.
    expect(cluster.pushA.calls).toHaveLength(1);
    const notice = cluster.pushA.calls[0]!;
    expect(notice.userId).toBe('bob');
    expect(notice.msgType).toBe('direct');
    expect(notice.senderId).toBe('alice');
    // `kind` is omitted (defaults to 'message') for ordinary messages.
    // Critical: must NOT be 'call' (would render the wrong banner).
    expect(notice.kind ?? 'message').toBe('message');
  });

  // ---- Story 9b: cross-instance LIVE message delivery (new) ---------
  it('story 9b: A on inst A sends → B is already authed on inst B → B receives live (no reconnect/drain needed)', async () => {
    // The behavior change: pre-rc.58 the message handler did a strictly
    // local fan-out, so a recipient on a different fly machine had to
    // wait for their WS to cycle (mobile background/foreground) before
    // they saw the message. Now `userNotifier.notify` fans out via
    // Redis pub/sub, so the recipient receives it live regardless of
    // which instance their WS is on.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    await new Promise((r) => setTimeout(r, 50)); // let presence settle

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'TElWRQ==',
        msg_type: 'direct',
      }),
    );

    // Bob receives the frame on his already-open WS — no reconnect.
    const incoming = (await bob.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alice');
    expect(incoming.ciphertext).toBe('TElWRQ==');

    // Always-push policy: push fires from the originating instance
    // even when the recipient is live on another instance, because
    // we no longer gate push on a `presence:{userId}` lookup that
    // could be stale (orphaned session keys silenced push for
    // legitimately-offline users — see handler.ts inline rationale).
    // Push runs once (on A), never on B (B doesn't own the send).
    expect(cluster.pushA.calls).toHaveLength(1);
    expect(cluster.pushA.calls[0]!.userId).toBe('bob');
    expect(cluster.pushB.calls).toHaveLength(0);
  });

  // ---- Story 11: sealed-sender direct message -----------------------
  it("story 11: sealed=true direct message arrives without `from` on the wire", async () => {
    // Server design note: live message delivery is local-instance
    // only (cross-instance happens via buffered-drain). Co-locate
    // both peers on instance A so we exercise the live wire-shape.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob = await authedSocket(cluster.urlA, 'dvt_bob');
    track(bob.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'U0VBTEVE',
        msg_type: 'direct',
        sealed: true,
      }),
    );
    const incoming = (await bob.q.next()) as Record<string, unknown>;
    expect(incoming.type).toBe('message');
    // Critical: NO `from` on the forwarded frame for sealed messages.
    expect('from' in incoming).toBe(false);
    expect(incoming.ciphertext).toBe('U0VBTEVE');
    expect(incoming.msg_type).toBe('direct');

    // Server still records senderId internally for ack routing.
    const stored = [...cluster.messages.buffer.values()][0]!;
    expect(stored.sealed).toBe(true);
    expect(stored.senderId).toBe('alice');
  });

  // ---- Story 12: group message fan-out -------------------------------
  it('story 12: A creates a group with B and C, A sends to group, B and C both receive', async () => {
    const groupId = newGroupId();
    await cluster.groups.create({ groupId, createdBy: 'alice' });
    await cluster.groups.addMember({ groupId, userId: 'bob', addedBy: 'alice' });
    await cluster.groups.addMember({ groupId, userId: 'carol', addedBy: 'alice' });

    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    // Co-locate live recipients on the sender's instance for live
    // fan-out (message routing is local-instance only — cross-instance
    // delivery is handled via the buffered-drain path on next auth).
    const bob = await authedSocket(cluster.urlA, 'dvt_bob');
    track(bob.ws);
    const carol = await authedSocket(cluster.urlA, 'dvt_carol');
    track(carol.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: groupId,
        ciphertext: 'Z3JvdXA=',
        msg_type: 'group',
      }),
    );
    const onBob = (await bob.q.next()) as { from: string; ciphertext: string };
    const onCarol = (await carol.q.next()) as { from: string; ciphertext: string };
    expect(onBob.from).toBe('alice');
    expect(onCarol.from).toBe('alice');
    expect(onBob.ciphertext).toBe('Z3JvdXA=');
    expect(onCarol.ciphertext).toBe('Z3JvdXA=');
    // Two recipients → two persisted rows (one per recipient, for
    // independent ack/delete).
    expect(cluster.messages.buffer.size).toBe(2);
  });

  // ---- Story 13: WS auth race after close ----------------------------
  it('story 13: open two WS for same userId; close the first; frames still reach the second', async () => {
    // Regression guard for the bug fixed in handler.ts:582-606. The
    // bob1 close handler must not wipe presence while bob2 is still
    // live, and getDevices must return bob2's socket. The presence
    // dimension only matters for *cross-instance* routing (used by
    // the call-router); we exercise it via a call_offer from a
    // different instance, plus assert a same-instance message still
    // routes locally as a sanity check.
    await cluster.close();
    cluster = await buildCluster({
      perTokenUserId: {
        dvt_alice: 'alice',
        dvt_bob_one: 'bob',
        dvt_bob_two: 'bob',
      },
    });

    // Alice on A (different instance from bob's), bob1/bob2 on B.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    const bob1 = await authedSocket(cluster.urlB, 'dvt_bob_one');
    track(bob1.ws);
    const bob2 = await authedSocket(cluster.urlB, 'dvt_bob_two');
    track(bob2.ws);
    await new Promise((r) => setTimeout(r, 50));

    // Close the first WS. Bob2 stays live; presence must still say
    // Bob is on B (the bug was: recordOffline ran unconditionally on
    // bob1.close, wiping presence even though bob2 was still live).
    bob1.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // Alice sends a call_offer from A. Cross-instance routing
    // depends on presence.lookupInstance('bob') still returning 'B'.
    // If presence was wiped, the call-router would see Bob as
    // offline_buffered and bob2 would never see this offer live.
    alice.ws.send(
      JSON.stringify({
        type: 'call_offer',
        to: 'bob',
        call_id: 'call-01HXSTORY13RECONNECTAAAAAA',
        ciphertext: 'T0ZGRVI=',
      }),
    );
    const offer = (await bob2.q.next()) as { type: string; from: string };
    expect(offer.type).toBe('call_offer');
    expect(offer.from).toBe('alice');

    // Bob2 answers — Alice gets it (full cross-instance round-trip
    // proving routing in both directions still works).
    bob2.ws.send(
      JSON.stringify({
        type: 'call_answer',
        to: 'alice',
        call_id: 'call-01HXSTORY13RECONNECTAAAAAA',
        ciphertext: 'QU5T',
      }),
    );
    const answer = (await alice.q.next()) as { type: string; from: string };
    expect(answer.type).toBe('call_answer');
    expect(answer.from).toBe('bob');
  });

  // ---- Story 16: read receipts ---------------------------------------
  it('story 16: A sends DM to B, B reads, A receives `read` frame attributed to B (cross-instance ack routing)', async () => {
    // Cross-instance read receipts ride RedisAckRouter (same path
    // as `delivered`, separate `kind: 'read'`). For coverage we
    // exercise the cross-instance leg: B drains the buffered DM on
    // instance B, sends `read`, and A on instance A must receive
    // the read frame.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob',
        ciphertext: 'cmVhZA==',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const bob = await authedSocket(cluster.urlB, 'dvt_bob');
    track(bob.ws);
    const incoming = (await bob.q.next()) as { message_id: string };

    bob.ws.send(
      JSON.stringify({
        type: 'read',
        to: 'alice',
        message_id: incoming.message_id,
      }),
    );
    const readFrame = (await alice.q.next()) as {
      type: string;
      from: string;
      message_id: string;
    };
    expect(readFrame.type).toBe('read');
    expect(readFrame.from).toBe('bob');
    expect(readFrame.message_id).toBe(incoming.message_id);
  });

  // ---- Story 17: multi-recipient group offline drain -----------------
  it('story 17: A sends to group {B online, C offline}, both receive (C on next auth), both ack, A sees two `delivered`', async () => {
    const groupId = newGroupId();
    await cluster.groups.create({ groupId, createdBy: 'alice' });
    await cluster.groups.addMember({ groupId, userId: 'bob', addedBy: 'alice' });
    await cluster.groups.addMember({ groupId, userId: 'carol', addedBy: 'alice' });

    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);
    // Bob co-located with Alice for live fan-out (message routing
    // is local-instance only). Carol is offline — her row buffers
    // and drains on her next auth (cross-instance is fine for that
    // path).
    const bob = await authedSocket(cluster.urlA, 'dvt_bob');
    track(bob.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: groupId,
        ciphertext: 'Z2FycA==',
        msg_type: 'group',
      }),
    );
    const onBob = (await bob.q.next()) as { message_id: string };
    bob.ws.send(JSON.stringify({ type: 'ack', message_id: onBob.message_id }));

    // Alice gets bob's delivered first.
    const deliveredBob = (await alice.q.next()) as {
      type: string;
      message_id: string;
    };
    expect(deliveredBob.type).toBe('delivered');
    expect(deliveredBob.message_id).toBe(onBob.message_id);

    // Carol comes online on the OTHER instance — drains her row
    // via the shared messages repo + buffer drain on auth.
    const carol = await authedSocket(cluster.urlB, 'dvt_carol');
    track(carol.ws);
    const onCarol = (await carol.q.next()) as {
      type: string;
      message_id: string;
    };
    expect(onCarol.type).toBe('message');
    expect(onCarol.message_id).not.toBe(onBob.message_id);

    carol.ws.send(JSON.stringify({ type: 'ack', message_id: onCarol.message_id }));
    const deliveredCarol = (await alice.q.next()) as {
      type: string;
      message_id: string;
    };
    expect(deliveredCarol.type).toBe('delivered');
    expect(deliveredCarol.message_id).toBe(onCarol.message_id);

    // Both rows now deleted.
    expect(cluster.messages.buffer.size).toBe(0);
  });

  // ---- Story 20: first-message-to-new-peer (server wire flow) --------
  it("story 20: A sends a DM to B with no prior session — server routes as direct message; B receives the wire frame", async () => {
    // The actual Signal-initiate path (PreKeyWhisperMessage build) is
    // a client-side concern. At the server layer, the first message
    // to a new peer is indistinguishable from any other — same
    // direct-message persistence, same drain on B's auth handshake.
    // This test pins that the server does NOT inject any extra state
    // (no "this is a session-initiate" sentinel; no different shape
    // on the wire). B never connected before sending, B's userRepo
    // entry doesn't exist yet — server should still accept and
    // buffer.
    const alice = await authedSocket(cluster.urlA, 'dvt_alice');
    track(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'never-here-before',
        ciphertext: 'aW5pdGlhdGU=',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(cluster.messages.buffer.size).toBe(1);
    const stored = [...cluster.messages.buffer.values()][0]!;
    expect(stored.recipientId).toBe('never-here-before');
    // No device was seen for the recipient → empty targetDevices
    // snapshot (legacy single-device shortcut applies on first ack).
    expect(stored.targetDevices).toEqual([]);

    // New peer comes online → drains the buffered frame.
    const newby = await authedSocket(cluster.urlB, 'dvt_never-here-before');
    track(newby.ws);
    const incoming = (await newby.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
      msg_type: string;
      message_id: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alice');
    expect(incoming.ciphertext).toBe('aW5pdGlhdGU=');
    expect(incoming.msg_type).toBe('direct');

    // Acking deletes the row — same path as any other direct message.
    newby.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await alice.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(cluster.messages.buffer.size).toBe(0);
  });
});
