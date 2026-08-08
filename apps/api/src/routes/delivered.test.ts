import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';
import type { BufferedMessage } from '../db/messages.js';

/**
 * The HTTP delivered-receipt is what a BACKGROUNDED push handler uses to ack a
 * message (its WebSocket is closed), clearing the relay row so the retry worker
 * doesn't re-send the push. These tests prove the row clears and that auth is
 * enforced.
 */
let app: Awaited<ReturnType<typeof buildServer>>;
let messagesRepo: InMemoryMessagesRepo;

function seedRow(id: string, over: Partial<BufferedMessage> = {}): void {
  void messagesRepo.insert({
    id,
    conversation: 'dm-x',
    senderId: 'alice-blue-fox',
    recipientId: 'bob-red-bear',
    ciphertext: Buffer.from('c'),
    msgType: 'direct',
    // No known devices at insert → any single ack deletes the row.
    targetDevices: [],
    deliveredToDevices: [],
    sealed: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  });
}

beforeEach(async () => {
  const userRepo = new InMemoryUserRepo();
  await userRepo.tryCreate({
    userId: 'bob-red-bear',
    deviceToken: 'dvt_bob',
    publicKey: Buffer.from('bob'),
    bundle: { registrationId: 1, signedPreKeyId: 1, signedPreKey: 'x', signedPreKeySig: 'y', preKeys: [{ id: 1, key: 'z' }] },
  });
  messagesRepo = new InMemoryMessagesRepo();
  const validator = new MockValidator((tok) =>
    tok === 'dvt_bob'
      ? { ok: true, attestation: { confidence: 'medium', userId: 'bob-red-bear' } }
      : { ok: false, reason: 'device_not_found' },
  );
  app = await buildServer({ validator, userRepo, messagesRepo, logger: false });
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/messages/delivered', () => {
  it('clears the relay row for an acked message', async () => {
    seedRow('m1');
    expect(messagesRepo.buffer.has('m1')).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/delivered',
      headers: { authorization: 'Bearer dvt_bob' },
      payload: { message_ids: ['m1'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().acked).toBe(1);
    expect(messagesRepo.buffer.has('m1')).toBe(false);
  });

  it('acks a batch and is idempotent on an already-cleared id', async () => {
    seedRow('a');
    seedRow('b');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/delivered',
      headers: { authorization: 'Bearer dvt_bob' },
      payload: { message_ids: ['a', 'b', 'a', 'never-existed'] },
    });
    expect(res.statusCode).toBe(200);
    expect(messagesRepo.buffer.size).toBe(0);
  });

  it('rejects an unauthenticated request', async () => {
    seedRow('m1');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/delivered',
      payload: { message_ids: ['m1'] },
    });
    expect(res.statusCode).toBe(401);
    expect(messagesRepo.buffer.has('m1')).toBe(true);
  });

  it('rejects an empty id list at the schema layer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/delivered',
      headers: { authorization: 'Bearer dvt_bob' },
      payload: { message_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
