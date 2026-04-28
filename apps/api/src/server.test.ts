import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from './server.js';

describe('healthz', () => {
  it('returns ok', async () => {
    const app = await buildServer({
      validator: MockValidator.alwaysSucceeds(),
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
