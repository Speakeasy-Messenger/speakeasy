import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, AddressInfo } from 'ws';
import { MockValidator } from '@speakeasy/vouchflow';
import { newCommunityId, newGroupId } from '@speakeasy/shared';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryConnections } from './connections.js';
import { InMemoryPresence } from '../presence/memory.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';
import { InMemoryGroupRepo } from '../db/groups.memory.js';
import { InMemoryCommunityRepo } from '../db/communities.memory.js';
import { MockPushProvider } from '../push/push.mock.js';

/**
 * Buffer-based message queue: every incoming WS frame is captured the moment
 * it arrives, so awaiting the next one never races against the server
 * sending two in quick succession (e.g. authed + a drained buffered message).
 */
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
  next(timeoutMs = 2000): Promise<unknown> {
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

let app: Awaited<ReturnType<typeof buildServer>>;
let url: string;
let connections: InMemoryConnections;
let presence: InMemoryPresence;
let messagesRepo: InMemoryMessagesRepo;
let groupRepo: InMemoryGroupRepo;
let communityRepo: InMemoryCommunityRepo;
let pushProvider: MockPushProvider;
const openSockets = new Set<WebSocket>();

function makeValidator(): MockValidator {
  // Tokens shaped `dvt_<userId>` succeed and bind to that userId.
  // `dvt_unenrolled` succeeds without a userId.
  // `dvt_low` fails low_confidence; `dvt_bad` fails device_not_found.
  return new MockValidator((tok) => {
    if (tok === 'dvt_low') return { ok: false, reason: 'low_confidence' };
    if (tok === 'dvt_bad') return { ok: false, reason: 'device_not_found' };
    if (tok === 'dvt_unenrolled') return { ok: true, attestation: { confidence: 'medium' } };
    if (tok.startsWith('dvt_')) {
      const userId = tok.slice('dvt_'.length);
      return { ok: true, attestation: { confidence: 'medium', userId } };
    }
    return { ok: false, reason: 'device_not_found' };
  });
}

beforeEach(async () => {
  connections = new InMemoryConnections();
  presence = new InMemoryPresence();
  messagesRepo = new InMemoryMessagesRepo();
  groupRepo = new InMemoryGroupRepo();
  communityRepo = new InMemoryCommunityRepo();
  pushProvider = new MockPushProvider();
  app = await buildServer({
    validator: makeValidator(),
    userRepo: new InMemoryUserRepo(),
    connections,
    presence,
    messagesRepo,
    groupRepo,
    communityRepo,
    push: pushProvider,
    instanceId: 'test-instance-1',
    logger: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${addr.port}/ws`;
});

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.terminate();
    }
  }
  openSockets.clear();
  await app.close();
});

function nextMsg(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
}

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.add(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('ws auth handshake', () => {
  it('rejects when first frame is not auth', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'ping' }));
    const err = (await nextMsg(ws)) as { type: string; code: string };
    expect(err.type).toBe('error');
    expect(err.code).toBe('unauthenticated');
  });

  it('rejects bad token', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'auth', token: 'dvt_bad' }));
    const err = (await nextMsg(ws)) as { type: string; code: string };
    expect(err.type).toBe('error');
    expect(err.code).toBe('device_not_found');
  });

  it('rejects token without userId (not enrolled)', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'auth', token: 'dvt_unenrolled' }));
    const err = (await nextMsg(ws)) as { type: string; code: string };
    expect(err.code).toBe('not_enrolled');
  });

  it('accepts a valid token and registers the connection', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'auth', token: 'dvt_silent-golden-hawk' }));
    const ok = (await nextMsg(ws)) as { type: string; user_id: string };
    expect(ok.type).toBe('authed');
    expect(ok.user_id).toBe('silent-golden-hawk');
    expect(connections.getDevices('silent-golden-hawk')).toHaveLength(1);

    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = (await nextMsg(ws)) as { type: string };
    expect(pong.type).toBe('pong');
  });

  it('routes a message between two live connections (delivered follows recipient ack)', async () => {
    const wsA = await open();
    const wsB = await open();
    const qA = new MsgQueue(wsA);
    const qB = new MsgQueue(wsB);
    wsA.send(JSON.stringify({ type: 'auth', token: 'dvt_alpha-bravo-charlie' }));
    await qA.next(); // authed
    wsB.send(JSON.stringify({ type: 'auth', token: 'dvt_delta-echo-foxtrot' }));
    await qB.next(); // authed

    wsA.send(
      JSON.stringify({
        type: 'message',
        to: 'delta-echo-foxtrot',
        ciphertext: 'AAA=',
        msg_type: 'direct',
      }),
    );
    const incoming = (await qB.next()) as {
      type: string;
      from: string;
      ciphertext: string;
      message_id: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alpha-bravo-charlie');
    expect(incoming.ciphertext).toBe('AAA=');

    // Phase 4: `delivered` only fires after the recipient acks (cross-instance
    // ack routing tightens spec §5).
    wsB.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const ack = (await qA.next()) as { type: string; message_id: string };
    expect(ack.type).toBe('delivered');
    expect(ack.message_id).toBe(incoming.message_id);
  });

  it('removes connection on close', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'auth', token: 'dvt_one-two-three' }));
    await nextMsg(ws);
    expect(connections.getDevices('one-two-three')).toHaveLength(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(connections.getDevices('one-two-three')).toHaveLength(0);
  });

  it('records presence online on auth and offline on close', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'auth', token: 'dvt_four-five-six' }));
    await nextMsg(ws);
    expect(await presence.lookupInstance('four-five-six')).toBe('test-instance-1');
    expect(await presence.lookupPresence('four-five-six')).toEqual({ state: 'online' });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await presence.lookupInstance('four-five-six')).toBeUndefined();
    const pres = await presence.lookupPresence('four-five-six');
    expect(pres.state).toBe('offline');
  });
});

describe('ws messaging — Phase 3', () => {
  async function authedSocket(
    userId: string,
  ): Promise<{ ws: WebSocket; q: MsgQueue }> {
    const ws = await open();
    const q = new MsgQueue(ws);
    ws.send(JSON.stringify({ type: 'auth', token: `dvt_${userId}` }));
    const authed = (await q.next()) as { type: string };
    expect(authed.type).toBe('authed');
    return { ws, q };
  }

  it('persists direct messages; delivered fires only after recipient acks', async () => {
    const a = await authedSocket('alice-blue-fox');
    const b = await authedSocket('bob-red-bear');

    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'AAA=',
        msg_type: 'direct',
      }),
    );
    const incoming = (await b.q.next()) as { message_id: string; from: string };
    expect(messagesRepo.buffer.size).toBe(1);
    const stored = [...messagesRepo.buffer.values()][0]!;
    expect(stored.senderId).toBe('alice-blue-fox');
    expect(stored.recipientId).toBe('bob-red-bear');

    b.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await a.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(incoming.message_id);
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('delivers buffered messages on reconnect; delivered fires after offline recipient acks', async () => {
    const a = await authedSocket('alice-blue-fox');
    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'YnVmZmVy',
        msg_type: 'direct',
      }),
    );
    // Bob isn't connected yet — give the server a moment to persist.
    await new Promise((r) => setTimeout(r, 30));
    expect(messagesRepo.buffer.size).toBe(1);

    const b = await authedSocket('bob-red-bear');
    const buffered = (await b.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
      message_id: string;
    };
    expect(buffered.type).toBe('message');
    expect(buffered.from).toBe('alice-blue-fox');
    expect(buffered.ciphertext).toBe('YnVmZmVy');

    b.ws.send(JSON.stringify({ type: 'ack', message_id: buffered.message_id }));
    const delivered = (await a.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(buffered.message_id);
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('group messages fan out to all members except the sender', async () => {
    const groupId = newGroupId();
    await groupRepo.create({ groupId, createdBy: 'alice-blue-fox' });
    await groupRepo.addMember({
      groupId,
      userId: 'bob-red-bear',
      addedBy: 'alice-blue-fox',
    });
    await groupRepo.addMember({
      groupId,
      userId: 'carol-pink-owl',
      addedBy: 'alice-blue-fox',
    });

    const a = await authedSocket('alice-blue-fox');
    const b = await authedSocket('bob-red-bear');
    const c = await authedSocket('carol-pink-owl');

    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: groupId,
        ciphertext: 'Z3JvdXA=',
        msg_type: 'group',
      }),
    );
    const bMsg = (await b.q.next()) as { from: string; ciphertext: string };
    const cMsg = (await c.q.next()) as { from: string; ciphertext: string };
    expect(bMsg.from).toBe('alice-blue-fox');
    expect(cMsg.from).toBe('alice-blue-fox');
    expect(bMsg.ciphertext).toBe('Z3JvdXA=');
    expect(cMsg.ciphertext).toBe('Z3JvdXA=');
    expect(messagesRepo.buffer.size).toBe(2);
  });

  it('community messages fan out and skip the sender', async () => {
    const communityId = newCommunityId();
    await communityRepo.create({ communityId, createdBy: 'alice-blue-fox' });
    await communityRepo.addMember({
      communityId,
      userId: 'bob-red-bear',
      addedBy: 'alice-blue-fox',
    });

    const a = await authedSocket('alice-blue-fox');
    const b = await authedSocket('bob-red-bear');

    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: communityId,
        ciphertext: 'Y29tbXVuaXR5',
        msg_type: 'community',
      }),
    );
    const bMsg = (await b.q.next()) as { from: string; ciphertext: string };
    expect(bMsg.from).toBe('alice-blue-fox');
    expect(bMsg.ciphertext).toBe('Y29tbXVuaXR5');
    expect(messagesRepo.buffer.size).toBe(1);
  });

  it('rejects sending to a group with no other members', async () => {
    const groupId = newGroupId();
    await groupRepo.create({ groupId, createdBy: 'alice-blue-fox' });
    const a = await authedSocket('alice-blue-fox');
    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: groupId,
        ciphertext: 'AAA=',
        msg_type: 'group',
      }),
    );
    const err = (await a.q.next()) as { type: string; code: string };
    expect(err.type).toBe('error');
    expect(err.code).toBe('no_recipients');
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('Phase 4 multi-device: a user with two devices receives the same message twice', async () => {
    // Bob has two devices. We give them distinct deviceTokens by using
    // a custom validator (default test validator binds 1 device to userId
    // by token-suffix; here we override with explicit per-token map).
    await app.close();
    const validator = new MockValidator((tok) => {
      if (tok === 'dvt_alice') {
        return { ok: true, attestation: { confidence: 'medium', userId: 'alice-blue-fox' } };
      }
      if (tok === 'dvt_bob_phone' || tok === 'dvt_bob_laptop') {
        return { ok: true, attestation: { confidence: 'medium', userId: 'bob-red-bear' } };
      }
      return { ok: false, reason: 'device_not_found' };
    });
    connections = new InMemoryConnections();
    presence = new InMemoryPresence();
    messagesRepo = new InMemoryMessagesRepo();
    pushProvider = new MockPushProvider();
    app = await buildServer({
      validator,
      userRepo: new InMemoryUserRepo(),
      connections,
      presence,
      messagesRepo,
      groupRepo: new InMemoryGroupRepo(),
      communityRepo: new InMemoryCommunityRepo(),
      push: pushProvider,
      instanceId: 'test-instance-multi',
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    const aliceWs = await open();
    const aliceQ = new MsgQueue(aliceWs);
    aliceWs.send(JSON.stringify({ type: 'auth', token: 'dvt_alice' }));
    await aliceQ.next();

    const phoneWs = await open();
    const phoneQ = new MsgQueue(phoneWs);
    phoneWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_phone' }));
    await phoneQ.next();

    const laptopWs = await open();
    const laptopQ = new MsgQueue(laptopWs);
    laptopWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_laptop' }));
    await laptopQ.next();

    expect(connections.getDevices('bob-red-bear')).toHaveLength(2);

    aliceWs.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'TVU=',
        msg_type: 'direct',
      }),
    );
    const onPhone = (await phoneQ.next()) as { type: string; from: string };
    const onLaptop = (await laptopQ.next()) as { type: string; from: string };
    expect(onPhone.type).toBe('message');
    expect(onLaptop.type).toBe('message');
    expect(onPhone.from).toBe('alice-blue-fox');
    expect(onLaptop.from).toBe('alice-blue-fox');
    // Single recipient userId → one buffered row even with two device fan-out.
    expect(messagesRepo.buffer.size).toBe(1);
  });

  it('Phase 5f: delivered fires only after EVERY known device of the recipient acks', async () => {
    await app.close();
    const validator = new MockValidator((tok) => {
      if (tok === 'dvt_alice') {
        return { ok: true, attestation: { confidence: 'medium', userId: 'alice-blue-fox' } };
      }
      if (tok === 'dvt_bob_phone' || tok === 'dvt_bob_laptop') {
        return { ok: true, attestation: { confidence: 'medium', userId: 'bob-red-bear' } };
      }
      return { ok: false, reason: 'device_not_found' };
    });
    connections = new InMemoryConnections();
    presence = new InMemoryPresence();
    messagesRepo = new InMemoryMessagesRepo();
    pushProvider = new MockPushProvider();
    app = await buildServer({
      validator,
      userRepo: new InMemoryUserRepo(),
      connections,
      presence,
      messagesRepo,
      groupRepo: new InMemoryGroupRepo(),
      communityRepo: new InMemoryCommunityRepo(),
      push: pushProvider,
      instanceId: 'test-instance-multi-ack',
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    // Both Bob devices auth FIRST so they're in DevicesRepo when Alice sends.
    const phoneWs = await open();
    const phoneQ = new MsgQueue(phoneWs);
    phoneWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_phone' }));
    await phoneQ.next();

    const laptopWs = await open();
    const laptopQ = new MsgQueue(laptopWs);
    laptopWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_laptop' }));
    await laptopQ.next();

    const aliceWs = await open();
    const aliceQ = new MsgQueue(aliceWs);
    aliceWs.send(JSON.stringify({ type: 'auth', token: 'dvt_alice' }));
    await aliceQ.next();

    aliceWs.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'bXVsdGk=',
        msg_type: 'direct',
      }),
    );
    const onPhone = (await phoneQ.next()) as { type: string; message_id: string };
    const onLaptop = (await laptopQ.next()) as { type: string; message_id: string };
    expect(onPhone.type).toBe('message');
    expect(onLaptop.type).toBe('message');
    expect(onPhone.message_id).toBe(onLaptop.message_id);

    // Phone acks first. Alice should NOT get delivered yet — laptop hasn't.
    phoneWs.send(JSON.stringify({ type: 'ack', message_id: onPhone.message_id }));
    // Give the AckRouter event loop time to fire — it shouldn't.
    await new Promise((r) => setTimeout(r, 50));
    // Row still in buffer (laptop hasn't acked).
    expect(messagesRepo.buffer.size).toBe(1);
    const stored = [...messagesRepo.buffer.values()][0]!;
    expect(stored.deliveredToDevices).toEqual(['dvt_bob_phone']);
    expect(stored.targetDevices.sort()).toEqual(['dvt_bob_laptop', 'dvt_bob_phone']);

    // Laptop acks → row deletes → alice gets delivered.
    laptopWs.send(JSON.stringify({ type: 'ack', message_id: onLaptop.message_id }));
    const delivered = (await aliceQ.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(onPhone.message_id);
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('Phase 5f: a device that re-acks (e.g. on reconnect) does not trigger delivered twice', async () => {
    await app.close();
    const validator = new MockValidator((tok) => {
      if (tok === 'dvt_alice') {
        return { ok: true, attestation: { confidence: 'medium', userId: 'alice-blue-fox' } };
      }
      if (tok === 'dvt_bob_phone' || tok === 'dvt_bob_laptop') {
        return { ok: true, attestation: { confidence: 'medium', userId: 'bob-red-bear' } };
      }
      return { ok: false, reason: 'device_not_found' };
    });
    connections = new InMemoryConnections();
    presence = new InMemoryPresence();
    messagesRepo = new InMemoryMessagesRepo();
    pushProvider = new MockPushProvider();
    app = await buildServer({
      validator,
      userRepo: new InMemoryUserRepo(),
      connections,
      presence,
      messagesRepo,
      groupRepo: new InMemoryGroupRepo(),
      communityRepo: new InMemoryCommunityRepo(),
      push: pushProvider,
      instanceId: 'test-instance-redrain',
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    // Bob's phone auths, alice sends, phone acks. Then Bob's phone reconnects.
    // Phone should NOT redrain its already-acked message — and the laptop
    // (only auths AFTER the message was sent) should NOT receive it either,
    // since it wasn't in targetDevices.
    const phoneWs = await open();
    const phoneQ = new MsgQueue(phoneWs);
    phoneWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_phone' }));
    await phoneQ.next();

    const aliceWs = await open();
    const aliceQ = new MsgQueue(aliceWs);
    aliceWs.send(JSON.stringify({ type: 'auth', token: 'dvt_alice' }));
    await aliceQ.next();

    aliceWs.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'cmVkcmFpbg==',
        msg_type: 'direct',
      }),
    );
    const got = (await phoneQ.next()) as { type: string; message_id: string };
    expect(got.type).toBe('message');
    phoneWs.send(JSON.stringify({ type: 'ack', message_id: got.message_id }));
    const delivered = (await aliceQ.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(messagesRepo.buffer.size).toBe(0);

    // Phone reconnects — should NOT redrain.
    phoneWs.close();
    await new Promise((r) => setTimeout(r, 30));
    const phoneAgainWs = await open();
    const phoneAgainQ = new MsgQueue(phoneAgainWs);
    phoneAgainWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_phone' }));
    const authedAgain = (await phoneAgainQ.next()) as { type: string };
    expect(authedAgain.type).toBe('authed');
    // No further frames should arrive — give the drain loop a moment.
    await expect(phoneAgainQ.next(150)).rejects.toThrow();

    // A laptop that auths AFTER the message was already delivered to phone
    // should also not receive a buffered drain (the row is gone). Even if
    // the row had still been around, laptop wasn't in targetDevices, so it
    // wouldn't drain.
    const laptopWs = await open();
    const laptopQ = new MsgQueue(laptopWs);
    laptopWs.send(JSON.stringify({ type: 'auth', token: 'dvt_bob_laptop' }));
    const laptopAuthed = (await laptopQ.next()) as { type: string };
    expect(laptopAuthed.type).toBe('authed');
    await expect(laptopQ.next(150)).rejects.toThrow();
  });

  it('Phase 4: fires push when recipient is offline; no push when online', async () => {
    // Online: Bob is connected → no push.
    const a = await authedSocket('alice-blue-fox');
    const b = await authedSocket('bob-red-bear');
    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'AAA=',
        msg_type: 'direct',
      }),
    );
    await b.q.next(); // message
    expect(pushProvider.calls).toHaveLength(0);

    // Offline: Carol isn't connected → push fires.
    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'carol-pink-owl',
        ciphertext: 'BBB=',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(pushProvider.calls).toHaveLength(1);
    expect(pushProvider.calls[0]!.userId).toBe('carol-pink-owl');
    expect(pushProvider.calls[0]!.msgType).toBe('direct');
    expect(pushProvider.calls[0]!.conversationId).toMatch(/^dm-[0-9a-f]{16}$/);
  });

  it('uses deterministic conversation id for direct messages', async () => {
    const a = await authedSocket('alice-blue-fox');
    await authedSocket('bob-red-bear');
    a.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: 'AAA=',
        msg_type: 'direct',
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const stored = [...messagesRepo.buffer.values()][0]!;
    expect(stored.conversation).toMatch(/^dm-[0-9a-f]{16}$/);
  });
});

describe('ws SKDM envelope — Phase 5b carry-over', () => {
  async function authedSocket(
    userId: string,
  ): Promise<{ ws: WebSocket; q: MsgQueue }> {
    const ws = await open();
    const q = new MsgQueue(ws);
    ws.send(JSON.stringify({ type: 'auth', token: `dvt_${userId}` }));
    const authed = (await q.next()) as { type: string };
    expect(authed.type).toBe('authed');
    return { ws, q };
  }

  it('forwards a live skdm to the recipient as a `skdm` frame', async () => {
    const groupId = newGroupId();
    const a = await authedSocket('alice-blue-fox');
    const b = await authedSocket('bob-red-bear');
    a.ws.send(
      JSON.stringify({
        type: 'skdm',
        to: 'bob-red-bear',
        group_id: groupId,
        ciphertext: 'c2tkbS1ib2R5', // base64 "skdm-body"
      }),
    );
    const frame = (await b.q.next()) as {
      type: string;
      from: string;
      group_id: string;
      ciphertext: string;
      message_id: string;
    };
    expect(frame.type).toBe('skdm');
    expect(frame.from).toBe('alice-blue-fox');
    expect(frame.group_id).toBe(groupId);
    expect(frame.ciphertext).toBe('c2tkbS1ib2R5');
    expect(typeof frame.message_id).toBe('string');
  });

  it('drains buffered skdm on recipient reconnect', async () => {
    const groupId = newGroupId();
    const a = await authedSocket('alice-blue-fox');
    a.ws.send(
      JSON.stringify({
        type: 'skdm',
        to: 'bob-red-bear',
        group_id: groupId,
        ciphertext: 'YnVmZmVyZWQtc2tkbQ==',
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(messagesRepo.buffer.size).toBe(1);
    const stored = [...messagesRepo.buffer.values()][0]!;
    expect(stored.skdmGroupId).toBe(groupId);

    const b = await authedSocket('bob-red-bear');
    const frame = (await b.q.next()) as {
      type: string;
      from: string;
      group_id: string;
      message_id: string;
    };
    expect(frame.type).toBe('skdm');
    expect(frame.from).toBe('alice-blue-fox');
    expect(frame.group_id).toBe(groupId);

    b.ws.send(JSON.stringify({ type: 'ack', message_id: frame.message_id }));
    // Allow the AckRouter event loop to fire delivered to alice.
    const delivered = (await a.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(frame.message_id);
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('rejects skdm-to-self', async () => {
    const groupId = newGroupId();
    const a = await authedSocket('alice-blue-fox');
    a.ws.send(
      JSON.stringify({
        type: 'skdm',
        to: 'alice-blue-fox',
        group_id: groupId,
        ciphertext: 'AA==',
      }),
    );
    const err = (await a.q.next()) as { type: string; code: string };
    expect(err.type).toBe('error');
    expect(err.code).toBe('invalid_target');
  });

  it('rejects skdm missing required fields', async () => {
    const a = await authedSocket('alice-blue-fox');
    a.ws.send(
      JSON.stringify({
        type: 'skdm',
        to: 'bob-red-bear',
        // group_id intentionally omitted
        ciphertext: 'AA==',
      }),
    );
    const err = (await a.q.next()) as { type: string; code: string };
    expect(err.type).toBe('error');
    expect(err.code).toBe('bad_skdm');
  });

  it('fires push when recipient is offline', async () => {
    const groupId = newGroupId();
    const a = await authedSocket('alice-blue-fox');
    a.ws.send(
      JSON.stringify({
        type: 'skdm',
        to: 'bob-red-bear',
        group_id: groupId,
        ciphertext: 'AA==',
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(pushProvider.calls).toHaveLength(1);
    expect(pushProvider.calls[0]).toMatchObject({
      userId: 'bob-red-bear',
      msgType: 'direct',
    });
  });
});
