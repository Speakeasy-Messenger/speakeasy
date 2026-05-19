import { describe, expect, it } from 'vitest';
import {
  ProductionConfigError,
  assertProductionConfig,
  collectProductionConfigErrors,
  isProductionEnv,
} from './production-guard.js';

/** A fully-valid production environment — the baseline each test mutates. */
function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://db/speakeasy',
    REDIS_URL: 'redis://redis:6379',
    FCM_PROJECT_ID: 'speakeasy-prod',
    VOUCHFLOW_READ_KEY: 'vrk_live_xxx',
    VOUCHFLOW_BASE_URL: 'https://api.vouchflow.dev/v1',
    CLOUDFLARE_TURN_KEY_ID: 'cf-key',
    CLOUDFLARE_TURN_TOKEN: 'cf-token',
    ADMIN_TOKEN: 'admin-secret',
  } as NodeJS.ProcessEnv;
}

describe('isProductionEnv', () => {
  it('is true for NODE_ENV=production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is false for dev / test / empty', () => {
    expect(isProductionEnv({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('treats a production-looking Fly app name as production', () => {
    expect(isProductionEnv({ FLY_APP_NAME: 'speakeasy-api' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('does not treat a sandbox/staging Fly app as production', () => {
    expect(isProductionEnv({ FLY_APP_NAME: 'speakeasy-sandbox' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionEnv({ FLY_APP_NAME: 'speakeasy-staging' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('collectProductionConfigErrors', () => {
  it('returns no errors for a fully-valid production env', () => {
    expect(collectProductionConfigErrors(validProdEnv())).toEqual([]);
  });

  it('flags the mock validator', () => {
    const env = { ...validProdEnv(), VOUCHFLOW_USE_MOCK: '1' };
    expect(collectProductionConfigErrors(env).join('\n')).toMatch(/VOUCHFLOW_USE_MOCK/);
  });

  it('flags missing DATABASE_URL and REDIS_URL', () => {
    const env = validProdEnv();
    delete env.DATABASE_URL;
    delete env.REDIS_URL;
    const errors = collectProductionConfigErrors(env);
    expect(errors.join('\n')).toMatch(/DATABASE_URL/);
    expect(errors.join('\n')).toMatch(/REDIS_URL/);
  });

  it('flags a sandbox Vouchflow base URL', () => {
    const env = { ...validProdEnv(), VOUCHFLOW_BASE_URL: 'https://sandbox.api.vouchflow.dev/v1' };
    expect(collectProductionConfigErrors(env).join('\n')).toMatch(/sandbox/);
  });

  it('allows a sandbox Vouchflow base URL with ALLOW_VOUCHFLOW_SANDBOX=1', () => {
    // The alpha deliberately runs against sandbox Vouchflow — sideloaded
    // debug APKs cannot pass production attestation.
    const env = {
      ...validProdEnv(),
      VOUCHFLOW_BASE_URL: 'https://sandbox.api.vouchflow.dev/v1',
      ALLOW_VOUCHFLOW_SANDBOX: '1',
    };
    expect(collectProductionConfigErrors(env)).toEqual([]);
  });

  it('flags a sub-medium confidence floor but allows medium / high', () => {
    expect(
      collectProductionConfigErrors({ ...validProdEnv(), VOUCHFLOW_MIN_CONFIDENCE: 'low' }).join('\n'),
    ).toMatch(/VOUCHFLOW_MIN_CONFIDENCE/);
    expect(
      collectProductionConfigErrors({ ...validProdEnv(), VOUCHFLOW_MIN_CONFIDENCE: 'high' }),
    ).toEqual([]);
  });

  it('flags METRICS_ENABLED=1 without a METRICS_TOKEN', () => {
    expect(
      collectProductionConfigErrors({ ...validProdEnv(), METRICS_ENABLED: '1' }).join('\n'),
    ).toMatch(/METRICS_TOKEN/);
    expect(
      collectProductionConfigErrors({
        ...validProdEnv(),
        METRICS_ENABLED: '1',
        METRICS_TOKEN: 'm',
      }),
    ).toEqual([]);
  });

  it('flags missing push, TURN and admin credentials', () => {
    const env = validProdEnv();
    delete env.FCM_PROJECT_ID;
    delete env.CLOUDFLARE_TURN_TOKEN;
    delete env.ADMIN_TOKEN;
    const joined = collectProductionConfigErrors(env).join('\n');
    expect(joined).toMatch(/FCM_PROJECT_ID/);
    expect(joined).toMatch(/CLOUDFLARE_TURN/);
    expect(joined).toMatch(/ADMIN_TOKEN/);
  });
});

describe('assertProductionConfig', () => {
  it('does nothing outside production, even with everything missing', () => {
    expect(() => assertProductionConfig({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('does nothing for a valid production env', () => {
    expect(() => assertProductionConfig(validProdEnv())).not.toThrow();
  });

  it('throws ProductionConfigError listing every violation in production', () => {
    let caught: unknown;
    try {
      assertProductionConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    // An empty production env violates every check.
    expect((caught as ProductionConfigError).violations.length).toBeGreaterThanOrEqual(6);
  });
});
