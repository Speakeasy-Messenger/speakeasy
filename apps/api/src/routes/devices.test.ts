import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryDevicesRepo } from '../db/devices.memory.js';

async function makeApp() {
  const devicesRepo = new InMemoryDevicesRepo();
  // Pre-register a device via upsertOnSeen (simulates WS auth handshake).
  await devicesRepo.upsertOnSeen({
    deviceToken: 'dvt_alpha_bravo',
    userId: 'alpha-bravo-charlie',
  });
  const validator = new MockValidator((tok) => {
    if (tok === 'dvt_alpha_bravo') {
      return {
        ok: true,
        attestation: { confidence: 'medium', userId: 'alpha-bravo-charlie' },
      };
    }
    return { ok: false, reason: 'device_not_found' };
  });
  const app = await buildServer({
    validator,
    userRepo: new InMemoryUserRepo(),
    devicesRepo,
    skipWebsocket: true,
    logger: false,
  });
  return { app, devicesRepo };
}

describe('POST /v1/devices/push-token', () => {
  it('stores push token for the authed device', async () => {
    const { app, devicesRepo } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: 'Bearer dvt_alpha_bravo' },
      payload: { push_token: 'fcm-token-123', platform: 'android' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const devices = await devicesRepo.listForUser('alpha-bravo-charlie');
    expect(devices).toHaveLength(1);
    expect(devices[0].pushToken).toBe('fcm-token-123');
    expect(devices[0].platform).toBe('android');
  });

  it('updates push token on subsequent calls', async () => {
    const { app, devicesRepo } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: 'Bearer dvt_alpha_bravo' },
      payload: { push_token: 'old-token', platform: 'android' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: 'Bearer dvt_alpha_bravo' },
      payload: { push_token: 'new-token', platform: 'android' },
    });
    expect(res.statusCode).toBe(200);

    const devices = await devicesRepo.listForUser('alpha-bravo-charlie');
    expect(devices[0].pushToken).toBe('new-token');
  });

  it('accepts ios platform', async () => {
    const { app, devicesRepo } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: 'Bearer dvt_alpha_bravo' },
      payload: { push_token: 'apns-token-456', platform: 'ios' },
    });
    expect(res.statusCode).toBe(200);

    const devices = await devicesRepo.listForUser('alpha-bravo-charlie');
    expect(devices[0].platform).toBe('ios');
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      payload: { push_token: 'fcm-token', platform: 'android' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing push_token', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: 'Bearer dvt_alpha_bravo' },
      payload: { platform: 'android' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid platform', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: 'Bearer dvt_alpha_bravo' },
      payload: { push_token: 'fcm-token', platform: 'windows' },
    });
    expect(res.statusCode).toBe(400);
  });
});
