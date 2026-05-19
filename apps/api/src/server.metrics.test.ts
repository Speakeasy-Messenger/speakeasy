import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import client from 'prom-client';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from './server.js';

const METRICS_TOKEN = 'test-metrics-token';

describe('/metrics endpoint (Phase 5f)', () => {
  let prevEnabled: string | undefined;
  let prevToken: string | undefined;
  beforeEach(() => {
    prevEnabled = process.env.METRICS_ENABLED;
    prevToken = process.env.METRICS_TOKEN;
  });
  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = prevEnabled;
    if (prevToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prevToken;
    // fastify-metrics registers default metrics on prom-client's global
    // registry; clear it so the next buildServer() in this process can
    // re-register without an "already registered" collision.
    client.register.clear();
  });

  it('returns 404 by default (gated behind METRICS_ENABLED=1)', async () => {
    delete process.env.METRICS_ENABLED;
    const app = await buildServer({
      validator: MockValidator.alwaysSucceeds(),
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('serves Prometheus exposition with a valid bearer token', async () => {
    process.env.METRICS_ENABLED = '1';
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    const app = await buildServer({
      validator: MockValidator.alwaysSucceeds(),
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // Prometheus exposition is text/plain (with optional version suffix).
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const body = res.body;
    expect(body).toContain('# HELP process_cpu_user_seconds_total');
    expect(body).toContain('# TYPE process_cpu_user_seconds_total counter');
    // Confirms fastify-metrics is wired into the request lifecycle.
    expect(body).toContain('http_request_duration_seconds');
    await app.close();
  });

  it('rejects /metrics with no / wrong bearer token (401)', async () => {
    process.env.METRICS_ENABLED = '1';
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    const app = await buildServer({
      validator: MockValidator.alwaysSucceeds(),
      skipWebsocket: true,
      logger: false,
    });
    const noAuth = await app.inject({ method: 'GET', url: '/metrics' });
    expect(noAuth.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });

  it('fails closed with 503 when METRICS_TOKEN is unset', async () => {
    process.env.METRICS_ENABLED = '1';
    delete process.env.METRICS_TOKEN;
    const app = await buildServer({
      validator: MockValidator.alwaysSucceeds(),
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
