import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { requireAuth } from './vouchflow.js';

async function makeApp(validator = MockValidator.alwaysSucceeds()) {
  const app = await buildServer({ validator, logger: false });
  app.get('/whoami', { preHandler: requireAuth }, async (req) => req.auth!);
  return app;
}

describe('requireAuth', () => {
  it('rejects requests with no Authorization header', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'missing_bearer_token' });
    await app.close();
  });

  it('rejects non-Bearer schemes', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects when the validator says device_not_found', async () => {
    const app = await makeApp(MockValidator.alwaysFailsWith('device_not_found'));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer dvt_anything' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('device_not_found');
    await app.close();
  });

  it('rejects low confidence with no override', async () => {
    const app = await makeApp(MockValidator.alwaysFailsWith('low_confidence'));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer dvt_x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('low_confidence');
    await app.close();
  });

  it('rejects stale verification', async () => {
    const app = await makeApp(MockValidator.alwaysFailsWith('stale_verification'));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer dvt_x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('stale_verification');
    await app.close();
  });

  it('accepts a valid deviceToken and attaches request.auth', async () => {
    const app = await makeApp(
      MockValidator.alwaysSucceeds({ confidence: 'high', userId: 'silent-golden-hawk' }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer dvt_real' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceToken).toBe('dvt_real');
    expect(body.confidence).toBe('high');
    expect(body.userId).toBe('silent-golden-hawk');
    await app.close();
  });

  it('does not gate /healthz', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
