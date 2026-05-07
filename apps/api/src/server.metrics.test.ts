import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from './server.js';

describe('/metrics endpoint (Phase 5f)', () => {
  let prevEnv: string | undefined;
  beforeEach(() => {
    prevEnv = process.env.METRICS_ENABLED;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = prevEnv;
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

  it('serves Prometheus exposition when METRICS_ENABLED=1', async () => {
    process.env.METRICS_ENABLED = '1';
    const app = await buildServer({
      validator: MockValidator.alwaysSucceeds(),
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    // Prometheus exposition is text/plain (with optional version
    // suffix); just assert the prefix.
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    // Body shape: HELP / TYPE comments interleaved with samples. The
    // process_cpu_user_seconds_total counter ships with every Node.js
    // fastify-metrics install — checking it pins the install.
    const body = res.body;
    expect(body).toContain('# HELP process_cpu_user_seconds_total');
    expect(body).toContain('# TYPE process_cpu_user_seconds_total counter');
    // HTTP metrics also fire — confirm the request-duration histogram
    // exists (proves fastify-metrics is wired into the request lifecycle,
    // not just the process-level metrics).
    expect(body).toContain('http_request_duration_seconds');
    await app.close();
  });
});
