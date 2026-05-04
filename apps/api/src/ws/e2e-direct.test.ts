import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, AddressInfo } from 'ws';
import { MockValidator } from '@speakeasy/vouchflow';
import { conversationIdForDirect } from '@speakeasy/shared';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryPreKeyRepo } from '../db/prekeys.memory.js';
import { InMemoryConnections } from './connections.js';
import { InMemoryPresence } from '../presence/memory.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';
import { InMemoryGroupRepo } from '../db/groups.memory.js';
import { InMemoryCommunityRepo } from '../db/communities.memory.js';
import { MockPushProvider } from '../push/push.mock.js';

/**
 * End-to-end happy path for 1:1 messaging.
 *
 * What this test exercises:
 *   - Two users (alice, bob) enroll into an in-memory user repo with full
 *     PreKey bundles.
 *   - Both auth a WebSocket session via MockValidator-backed handshake.
 *   - Alice fetches Bob's bundle via the real `POST /v1/prekeys/bundle`
 *     route — server consumes one one-time prekey and replies with the
 *     bundle the mobile client would feed into `signalProtocol.initiateSession`.
 *   - "Encrypt" stub: prepend the SignalMessage marker (0x02) to the
 *     plaintext bytes (matches the native bridge convention used by
 *     MockSignalProtocolClient on the mobile side). The server is opaque
 *     to the encoding either way.
 *   - Alice sends the message frame; Bob receives; Bob "decrypts" by
 *     stripping the marker; assert the recovered bytes equal the
 *     original plaintext.
 *   - Bob acks; the server announces via AckRouter; Alice receives the
 *     `delivered` frame.
 *   - Buffer is cleared, OTPK count decreased by exactly one.
 *
 * This is the closest-to-production single-process integration we can
 * write without booting the real native libsignal bridges. It catches
 * regressions in: prekey route, WS auth, message routing, persistence,
 * ack/delivered, and conversation-id determinism — in one shot.
 */

interface BundleInput {
  registrationId: number;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySig: string;
  preKeys: Array<{ id: number; key: string }>;
}
function freshBundle(seed: string, prekeyCount = 5): BundleInput {
  return {
    registrationId: seed.charCodeAt(0) + seed.charCodeAt(1),
    signedPreKeyId: 1,
    signedPreKey: Buffer.from(`${seed}-spk`).toString('base64'),
    signedPreKeySig: Buffer.from(`${seed}-sig`).toString('base64'),
    preKeys: Array.from({ length: prekeyCount }, (_, i) => ({
      id: i + 1,
      key: Buffer.from(`${seed}-otpk-${i + 1}`).toString('base64'),
    })),
  };
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
let messagesRepo: InMemoryMessagesRepo;
let userRepo: InMemoryUserRepo;
let preKeyRepo: InMemoryPreKeyRepo;
let pushProvider: MockPushProvider;
const openSockets = new Set<WebSocket>();

beforeEach(async () => {
  userRepo = new InMemoryUserRepo();
  await userRepo.tryCreate({ userId: 'alice-blue-fox', deviceToken: 'dvt_alice-blue-fox', publicKey: Buffer.from('alice-id-pub'),
    bundle: freshBundle('alice'),
  });
  // 30 OTPKs for the happy-path test (above the 10-key low_water
  // threshold so the bundle fetch doesn't surface a `prekeys_low` frame
  // mid-conversation). Tests that exercise low_water explicitly rebuild
  // the user with fewer keys.
  await userRepo.tryCreate({ userId: 'bob-red-bear', deviceToken: 'dvt_bob-red-bear', publicKey: Buffer.from('bob-id-pub'),
    bundle: freshBundle('bob', 30),
  });
  preKeyRepo = new InMemoryPreKeyRepo(userRepo);
  messagesRepo = new InMemoryMessagesRepo();
  pushProvider = new MockPushProvider();

  const validator = new MockValidator((tok) => {
    if (tok === 'dvt_alice') {
      return { ok: true, attestation: { confidence: 'medium', userId: 'alice-blue-fox' } };
    }
    if (tok === 'dvt_bob') {
      return { ok: true, attestation: { confidence: 'medium', userId: 'bob-red-bear' } };
    }
    return { ok: false, reason: 'device_not_found' };
  });

  app = await buildServer({
    validator,
    userRepo,
    preKeyRepo,
    connections: new InMemoryConnections(),
    presence: new InMemoryPresence(),
    messagesRepo,
    groupRepo: new InMemoryGroupRepo(),
    communityRepo: new InMemoryCommunityRepo(),
    push: pushProvider,
    instanceId: 'e2e-test',
    logger: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
  }
  openSockets.clear();
  await app.close();
});

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.add(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function authedSocket(token: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = await open();
  const q = new MsgQueue(ws);
  ws.send(JSON.stringify({ type: 'auth', token }));
  const authed = (await q.next()) as { type: string };
  expect(authed.type).toBe('authed');
  return { ws, q };
}

/** Mirrors MockSignalProtocolClient.encrypt: prepend the 0x02 marker. */
function mockEncrypt(plaintext: Uint8Array): Uint8Array {
  const out = new Uint8Array(plaintext.length + 1);
  out[0] = 0x02;
  out.set(plaintext, 1);
  return out;
}
function mockDecrypt(ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length === 0) return ciphertext;
  return ciphertext.slice(1);
}

describe('1:1 end-to-end (prekey fetch → session → encrypted send → ack → delivered)', () => {
  it('alice fetches bob\'s bundle, encrypts, sends; bob decrypts; bob acks; alice gets delivered', async () => {
    // Step 1: both parties open authed WS sessions.
    const alice = await authedSocket('dvt_alice');
    const bob = await authedSocket('dvt_bob');

    // Step 2: alice fetches bob's prekey bundle via the real HTTP route.
    // Server consumes one OTPK and replies.
    const otpkCountBefore = await preKeyRepo.countRemaining('bob-red-bear');
    const bundleRes = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_alice' },
      payload: { user_id: 'bob-red-bear' },
    });
    expect(bundleRes.statusCode).toBe(200);
    const peerBundle = bundleRes.json() as {
      user_id: string;
      identity_public_key: string;
      registration_id: number;
      signed_prekey_id: number;
      signed_prekey: string;
      signed_prekey_sig: string;
      one_time_prekey: { id: number; key: string };
      remaining_prekeys: number;
    };
    expect(peerBundle.user_id).toBe('bob-red-bear');
    expect(peerBundle.identity_public_key).toBe(Buffer.from('bob-id-pub').toString('base64'));
    expect(peerBundle.one_time_prekey).toBeDefined();
    expect(peerBundle.remaining_prekeys).toBe(otpkCountBefore - 1);

    // Step 3: alice "initiates session" (mock: just remember the bundle).
    // The real signalProtocol.initiateSession would consume the OTPK
    // server-side and stash the session in the SQLCipher store. Mock
    // is a no-op — we proceed straight to encrypt.

    // Step 4: alice encrypts a real-ish payload + sends.
    const plaintext = new TextEncoder().encode('hello, bob — see you in 7 days.');
    const ciphertextBytes = mockEncrypt(plaintext);
    const wireB64 = Buffer.from(ciphertextBytes).toString('base64');

    alice.ws.send(
      JSON.stringify({
        type: 'message',
        to: 'bob-red-bear',
        ciphertext: wireB64,
        msg_type: 'direct',
      }),
    );

    // Step 5: bob receives. Verify the wire frame shape (§9 spec) and
    // round-trip the ciphertext.
    const incoming = (await bob.q.next()) as {
      type: string;
      from: string;
      ciphertext: string;
      message_id: string;
      msg_type: string;
    };
    expect(incoming.type).toBe('message');
    expect(incoming.from).toBe('alice-blue-fox');
    expect(incoming.msg_type).toBe('direct');
    const recoveredCipher = new Uint8Array(Buffer.from(incoming.ciphertext, 'base64'));
    expect(recoveredCipher).toEqual(ciphertextBytes);
    const recoveredPlaintext = mockDecrypt(recoveredCipher);
    expect(new TextDecoder().decode(recoveredPlaintext)).toBe(
      'hello, bob — see you in 7 days.',
    );

    // Step 6: server persisted exactly one row, with the byte-perfect
    // ciphertext and the deterministic conversation_id.
    expect(messagesRepo.buffer.size).toBe(1);
    const stored = [...messagesRepo.buffer.values()][0]!;
    expect(stored.senderId).toBe('alice-blue-fox');
    expect(stored.recipientId).toBe('bob-red-bear');
    expect(stored.conversation).toBe(
      conversationIdForDirect('alice-blue-fox', 'bob-red-bear'),
    );
    expect(stored.ciphertext.equals(Buffer.from(ciphertextBytes))).toBe(true);

    // Step 7: bob acks. Alice receives `delivered` with the same id;
    // server clears the buffer.
    bob.ws.send(JSON.stringify({ type: 'ack', message_id: incoming.message_id }));
    const delivered = (await alice.q.next()) as { type: string; message_id: string };
    expect(delivered.type).toBe('delivered');
    expect(delivered.message_id).toBe(incoming.message_id);
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('rejects bundle fetch for an unenrolled peer (404 not_found)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_alice' },
      payload: { user_id: 'never-enrolled-anyone' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('emits prekeys_low to the bundle owner once their pool drops below the threshold', async () => {
    // Re-create bob with only 5 OTPKs so he's already below the
    // low_water threshold (spec §4: 10). Re-auth bob so the in-process
    // notifier can reach him.
    await app.close();
    userRepo = new InMemoryUserRepo();
    await userRepo.tryCreate({ userId: 'alice-blue-fox', deviceToken: 'dvt_alice-blue-fox', publicKey: Buffer.from('alice-id-pub'),
      bundle: freshBundle('alice'),
    });
    await userRepo.tryCreate({ userId: 'bob-red-bear', deviceToken: 'dvt_bob-red-bear', publicKey: Buffer.from('bob-id-pub'),
      bundle: freshBundle('bob', 5),
    });
    preKeyRepo = new InMemoryPreKeyRepo(userRepo);
    messagesRepo = new InMemoryMessagesRepo();
    pushProvider = new MockPushProvider();
    const validator = new MockValidator((tok) => {
      if (tok === 'dvt_alice')
        return { ok: true, attestation: { confidence: 'medium', userId: 'alice-blue-fox' } };
      if (tok === 'dvt_bob')
        return { ok: true, attestation: { confidence: 'medium', userId: 'bob-red-bear' } };
      return { ok: false, reason: 'device_not_found' };
    });
    app = await buildServer({
      validator,
      userRepo,
      preKeyRepo,
      connections: new InMemoryConnections(),
      presence: new InMemoryPresence(),
      messagesRepo,
      groupRepo: new InMemoryGroupRepo(),
      communityRepo: new InMemoryCommunityRepo(),
      push: pushProvider,
      instanceId: 'e2e-test-low',
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    const bob = await authedSocket('dvt_bob');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_alice' },
      payload: { user_id: 'bob-red-bear' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().low_water).toBe(true);
    const note = (await bob.q.next()) as { type: string; remaining_prekeys: number };
    expect(note.type).toBe('prekeys_low');
    expect(typeof note.remaining_prekeys).toBe('number');
    expect(note.remaining_prekeys).toBeLessThan(10);
  });
});
