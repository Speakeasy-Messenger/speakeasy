import { afterEach, describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryDevicesRepo } from '../db/devices.memory.js';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';

/**
 * Seed a server whose devices repo has `active` users (a device seen
 * just now — inside the 24h broadcast window) and `stale` users (a
 * device last seen 48h ago — a dead test account the broadcast skips).
 */
async function makeApp(args: { active: string[]; stale?: string[] }) {
  const devicesRepo = new InMemoryDevicesRepo();
  for (const id of args.active) {
    await devicesRepo.upsertOnSeen({ deviceToken: `dvt_${id}`, userId: id });
  }
  const staleAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const id of args.stale ?? []) {
    devicesRepo.devices.set(`dvt_${id}`, {
      deviceToken: `dvt_${id}`,
      userId: id,
      enrolledAt: staleAt,
      lastSeen: staleAt,
    });
  }
  const messagesRepo = new InMemoryMessagesRepo();
  const app = await buildServer({
    validator: MockValidator.alwaysSucceeds(),
    devicesRepo,
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

  it('fans an announcement out to recently-active users, skipping stale ones', async () => {
    process.env.ADMIN_TOKEN = 'test-admin-token';
    const { app, messagesRepo } = await makeApp({
      active: ['alpha-blue-fox', 'bravo-red-bear'],
      stale: ['charlie-dead-test'],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/broadcast',
      headers: { authorization: 'Bearer test-admin-token' },
      payload: { text: 'New build rc.96 available' },
    });
    expect(res.statusCode).toBe(200);
    // charlie-dead-test authed 48h ago — outside the 24h window.
    expect(res.json()).toEqual({ ok: true, sent: 2 });
    expect(messagesRepo.buffer.size).toBe(2);
    const recipients = new Set(
      [...messagesRepo.buffer.values()].map((m) => m.recipientId),
    );
    expect(recipients).toEqual(new Set(['alpha-blue-fox', 'bravo-red-bear']));
    for (const m of messagesRepo.buffer.values()) {
      expect(m.senderId).toBe('speaker');
      expect(m.msgType).toBe('direct');
    }
  });

  it('rejects a bad admin token', async () => {
    process.env.ADMIN_TOKEN = 'test-admin-token';
    const { app } = await makeApp({ active: ['alpha-blue-fox'] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/broadcast',
      headers: { authorization: 'Bearer wrong' },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
  });
});
