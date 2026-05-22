import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { InMemoryDevicesRepo } from '../db/devices.memory.js';
import { InMemoryEventLogRepo } from '../db/event-log.memory.js';
import { MockValidator } from '@speakeasy/vouchflow';

const ADMIN_TOKEN = 'test-admin-token';

async function makeApp() {
  const devicesRepo = new InMemoryDevicesRepo();
  const eventLog = new InMemoryEventLogRepo();
  const app = await buildServer({
    validator: new MockValidator(),
    devicesRepo,
    eventLog,
    logger: false,
  });
  return { app, devicesRepo, eventLog };
}

describe('admin diagnostics routes', () => {
  const previous = process.env.ADMIN_TOKEN;

  beforeEach(() => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previous;
  });

  it('requires a valid admin bearer token', async () => {
    const { app } = await makeApp();
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/alice/devices',
    });
    expect(missing.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/alice/devices',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(bad.statusCode).toBe(403);
    await app.close();
  });

  it('redacts device and push tokens from device diagnostics', async () => {
    const { app, devicesRepo } = await makeApp();
    const deviceToken = 'dvt_alice_device_secret_token_123456';
    const pushToken = 'fcm_secret_push_token_abcdef';
    await devicesRepo.upsertOnSeen({ deviceToken, userId: 'alice' });
    await devicesRepo.setPushToken({
      deviceToken,
      userId: 'alice',
      pushToken,
      platform: 'android',
      notificationPrivacy: 'private',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/alice/devices',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain(deviceToken);
    expect(JSON.stringify(body)).not.toContain(pushToken);
    expect(body.devices[0]).toMatchObject({
      deviceTokenPreview: 'dvt_alice_de...',
      pushTokenPreview: 'fcm_secr...',
      hasPushToken: true,
      platform: 'android',
      notificationPrivacy: 'private',
    });
    await app.close();
  });

  it('deletes by full token but logs only a redacted preview', async () => {
    const { app, devicesRepo, eventLog } = await makeApp();
    const deviceToken = 'dvt_alice_device_secret_token_123456';
    await devicesRepo.upsertOnSeen({ deviceToken, userId: 'alice' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/alice/devices/${encodeURIComponent(deviceToken)}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(await devicesRepo.listForUser('alice')).toEqual([]);
    expect(JSON.stringify(eventLog.rows)).not.toContain(deviceToken);
    expect(eventLog.rows[0]).toMatchObject({
      eventType: 'admin.device_deleted',
      userId: 'alice',
      payload: { deviceTokenPreview: 'dvt_alice_de...' },
    });
    await app.close();
  });
});
