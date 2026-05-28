import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryAbuseReportsRepo } from '../db/abuse-reports.js';

function makeValidator(): MockValidator {
  return new MockValidator((tok) => {
    if (tok.startsWith('dvt_')) {
      return {
        ok: true,
        attestation: { confidence: 'medium', userId: tok.slice('dvt_'.length) },
      };
    }
    return { ok: false, reason: 'device_not_found' };
  });
}

function bundle() {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: Buffer.from('spk').toString('base64'),
    signedPreKeySig: Buffer.from('sig').toString('base64'),
    preKeys: [{ id: 1, key: Buffer.from('k1').toString('base64') }],
  };
}

/** Set up a server with N+1 users: `target` plus `reporter1..N`. */
async function makeApp(reporterCount: number) {
  const repo = new InMemoryUserRepo();
  const abuseReports = new InMemoryAbuseReportsRepo();
  await repo.tryCreate({
    userId: 'target',
    deviceToken: 'dvt_target',
    publicKey: Buffer.from('target-pk'),
    bundle: bundle(),
  });
  for (let i = 1; i <= reporterCount; i++) {
    await repo.tryCreate({
      userId: `reporter${i}`,
      deviceToken: `dvt_reporter${i}`,
      publicKey: Buffer.from(`pk${i}`),
      bundle: bundle(),
    });
  }
  const app = await buildServer({
    validator: makeValidator(),
    userRepo: repo,
    abuseReports,
    logger: false,
  });
  return { app, repo, abuseReports };
}

describe('POST /v1/users/:handle/report', () => {
  it('records a report and returns recorded:true, banned:false', async () => {
    const { app, repo } = await makeApp(1);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'spam' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, recorded: true, banned: false });
    // Target still exists — under threshold.
    expect(await repo.findById('target')).toBeDefined();
  });

  it('dedups: same reporter against same target the second time returns recorded:false', async () => {
    const { app } = await makeApp(1);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'spam' },
    });
    expect(first.json().recorded).toBe(true);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'harassment' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, recorded: false, banned: false });
  });

  it('triggers auto-ban when 5 distinct reporters file', async () => {
    const { app, repo } = await makeApp(5);
    for (let i = 1; i <= 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/users/target/report',
        headers: { authorization: `Bearer dvt_reporter${i}` },
        payload: { reason: 'spam' },
      });
      expect(res.json().banned).toBe(false);
    }
    expect(await repo.findById('target')).toBeDefined();
    // 5th report crosses the threshold.
    const fifth = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter5' },
      payload: { reason: 'threats' },
    });
    expect(fifth.statusCode).toBe(200);
    expect(fifth.json()).toEqual({ ok: true, recorded: true, banned: true });
    expect(await repo.findById('target')).toBeUndefined();
  });

  it('one user filing 5 reports against themselves and one target does NOT trigger ban (dedup)', async () => {
    // After self-report rejection, the same reporter cannot file 5
    // separate reports against the same target either — the
    // (reporter, reported) unique guarantees the count stays at 1.
    const { app, repo } = await makeApp(1);
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/users/target/report',
        headers: { authorization: 'Bearer dvt_reporter1' },
        payload: { reason: 'spam' },
      });
      expect(res.json().banned).toBe(false);
    }
    expect(await repo.findById('target')).toBeDefined();
  });

  it('rejects self-report with 400', async () => {
    const { app, repo } = await makeApp(0);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_target' },
      payload: { reason: 'spam' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'self_report' });
    expect(await repo.findById('target')).toBeDefined();
  });

  it('returns 404 when the reported handle does not exist', async () => {
    const { app } = await makeApp(1);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/ghost/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'spam' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'user_not_found' });
  });

  it('rejects unknown reason values', async () => {
    const { app } = await makeApp(1);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'not-a-real-reason' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an optional detail field within the 200-char cap', async () => {
    const { app, abuseReports } = await makeApp(1);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'other', detail: 'a specific explanation' },
    });
    expect(res.statusCode).toBe(200);
    const stored = await abuseReports.listForReported('target');
    expect(stored[0]!.detail).toBe('a specific explanation');
  });

  it('rejects detail longer than 200 chars', async () => {
    const { app } = await makeApp(1);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter1' },
      payload: { reason: 'other', detail: 'x'.repeat(201) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const { app } = await makeApp(1);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      payload: { reason: 'spam' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('aged-out reports do not count toward the ban threshold', async () => {
    // Push the decay window to ~0 so the first 4 reports immediately
    // age out. The 5th report alone shouldn't trip the threshold —
    // active count is 1, not 5.
    const { app, repo, abuseReports } = await makeApp(5);
    for (let i = 1; i <= 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/users/target/report',
        headers: { authorization: `Bearer dvt_reporter${i}` },
        payload: { reason: 'spam' },
      });
    }
    // Now squeeze the decay window so the existing 4 reports are
    // "old" relative to whatever the 5th report's check sees.
    abuseReports.setDecayMs(1);
    await new Promise((r) => setTimeout(r, 5));
    const fifth = await app.inject({
      method: 'POST',
      url: '/v1/users/target/report',
      headers: { authorization: 'Bearer dvt_reporter5' },
      payload: { reason: 'spam' },
    });
    expect(fifth.json().banned).toBe(false);
    expect(await repo.findById('target')).toBeDefined();
  });
});
