import { afterEach, describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';

const DUMMY_BUNDLE = {
  registrationId: 1,
  signedPreKeyId: 1,
  signedPreKey: 'AA==',
  signedPreKeySig: 'AA==',
  preKeys: [{ id: 1, key: 'AA==' }],
};

async function makeApp(userIds: string[]) {
  const userRepo = new InMemoryUserRepo();
  for (const id of userIds) {
    await userRepo.tryCreate({
      userId: id,
      deviceToken: `dvt_${id}`,
      publicKey: Buffer.from([0]),
      bundle: DUMMY_BUNDLE,
    });
  }
  const messagesRepo = new InMemoryMessagesRepo();
  const app = await buildServer({
    validator: MockValidator.alwaysSucceeds(),
    userRepo,
    messagesRepo,
    skipWebsocket: true,
    logger: false,
  });
  return { app, messagesRepo };
}

describe('POST /v1/broadcast', () => {
  const prev = process.env.ADMIN_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });

  it('fans an announcement out to every user', async () => {
    process.env.ADMIN_TOKEN = 'test-admin-token';
    const { app, messagesRepo } = await makeApp([
      'alpha-blue-fox',
      'bravo-red-bear',
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/broadcast',
      headers: { authorization: 'Bearer test-admin-token' },
      payload: { text: 'New build rc.95 available' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sent: 2 });
    expect(messagesRepo.buffer.size).toBe(2);
    for (const m of messagesRepo.buffer.values()) {
      expect(m.senderId).toBe('speaker');
      expect(m.msgType).toBe('direct');
    }
  });

  it('rejects a bad admin token', async () => {
    process.env.ADMIN_TOKEN = 'test-admin-token';
    const { app } = await makeApp(['alpha-blue-fox']);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/broadcast',
      headers: { authorization: 'Bearer wrong' },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
  });
});
