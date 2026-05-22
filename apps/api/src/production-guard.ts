/**
 * Fail-closed production configuration guard.
 *
 * `buildServer()` is deliberately permissive: a missing `DATABASE_URL` /
 * `REDIS_URL` / FCM credential silently degrades to an in-memory or no-op
 * implementation so unit tests and local dev need zero infrastructure. That
 * convenience is a production hazard — a misconfigured deploy would boot
 * "successfully" with an unverified mock validator, a single-instance
 * in-memory datastore that loses data on restart, and push notifications
 * dropped on the floor.
 *
 * This guard runs only for the real server process (`main()` in
 * `server.ts`) and only when the environment declares itself production.
 * It collects *every* violation and reports them at once, so an operator
 * sees the full list instead of fixing them one failed redeploy at a time.
 *
 * Tests and local dev are unaffected: they call `buildServer()` directly,
 * never `main()`, and `isProductionEnv()` returns false for them.
 */

/** Thrown by `assertProductionConfig` — carries the full violation list. */
export class ProductionConfigError extends Error {
  constructor(public readonly violations: string[]) {
    super(
      `Refusing to start: ${violations.length} production configuration ` +
        `violation(s) detected.\n` +
        violations.map((v) => `  ✗ ${v}`).join('\n') +
        '\n\nFix the environment, or unset NODE_ENV=production for a ' +
        'dev/sandbox box. In-memory and no-op fallbacks remain available ' +
        'for tests and local development — they are simply not allowed to ' +
        'ship to production.',
    );
    this.name = 'ProductionConfigError';
  }
}

/**
 * Whether the process is running as a production deployment.
 *
 * `NODE_ENV=production` is the explicit signal. As a backstop, Fly stamps
 * `FLY_APP_NAME` into every machine — an app name that doesn't look like a
 * sandbox/staging/dev environment is treated as production too, so a
 * deploy that forgets `NODE_ENV` still gets gated.
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  const fly = env.FLY_APP_NAME;
  if (fly && !/sandbox|staging|stg|dev|test/i.test(fly)) return true;
  return false;
}

/**
 * Collect every production-config violation in the given environment.
 * Pure — takes the env explicitly so it is trivially unit-testable.
 */
export function collectProductionConfigErrors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const errors: string[] = [];

  if (env.VOUCHFLOW_USE_MOCK === '1') {
    errors.push(
      'VOUCHFLOW_USE_MOCK=1 — the mock validator accepts any token without ' +
        'verification. Unset it.',
    );
  }

  if (!env.DATABASE_URL) {
    errors.push(
      'DATABASE_URL is missing — the API would fall back to in-memory ' +
        'repositories: all users, prekeys, messages and groups are lost on ' +
        'restart and never shared across instances.',
    );
  }

  if (!env.REDIS_URL) {
    errors.push(
      'REDIS_URL is missing — presence, rate limiting, ack routing and call ' +
        'buffering would fall back to single-instance in-memory ' +
        'implementations that break across more than one machine.',
    );
  }

  if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
    errors.push(
      'FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY must all be set — ' +
        'push notifications would fail Firebase Admin initialization or be ' +
        'silently dropped (NoopPushProvider).',
    );
  }
  if (env.FCM_PRIVATE_KEY && !env.FCM_PRIVATE_KEY.includes('PRIVATE KEY')) {
    errors.push(
      'FCM_PRIVATE_KEY does not look like a PEM private key — Firebase Admin ' +
        'credential initialization is likely to fail.',
    );
  }

  const baseUrl = env.VOUCHFLOW_BASE_URL ?? '';
  if (!env.VOUCHFLOW_READ_KEY || !baseUrl) {
    errors.push(
      'VOUCHFLOW_READ_KEY and VOUCHFLOW_BASE_URL must both be set — the ' +
        'server cannot validate device attestations without them.',
    );
  }
  // The current alpha intentionally runs its production server against
  // sandbox Vouchflow: testers sideload debug-signed APKs, which cannot
  // pass production Play Integrity / App Attest, so production Vouchflow
  // would reject every one of them. ALLOW_VOUCHFLOW_SANDBOX=1 is the
  // explicit operator opt-in acknowledging that deliberate config; the
  // check still fires for anyone who lands on sandbox by accident.
  if (
    baseUrl.toLowerCase().includes('sandbox') &&
    env.ALLOW_VOUCHFLOW_SANDBOX !== '1'
  ) {
    errors.push(
      `VOUCHFLOW_BASE_URL points at sandbox (${baseUrl}) — the sandbox ` +
        'endpoint relaxes the attestation confidence floor to "low". ' +
        'Use the production Vouchflow endpoint, or set ' +
        'ALLOW_VOUCHFLOW_SANDBOX=1 to acknowledge a deliberate alpha config.',
    );
  }

  const minConfidence = env.VOUCHFLOW_MIN_CONFIDENCE;
  if (minConfidence && minConfidence !== 'medium' && minConfidence !== 'high') {
    errors.push(
      `VOUCHFLOW_MIN_CONFIDENCE=${minConfidence} is below the production ` +
        'floor of "medium".',
    );
  }

  if (!env.CLOUDFLARE_TURN_KEY_ID || !env.CLOUDFLARE_TURN_TOKEN) {
    errors.push(
      'CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_TOKEN are missing — calls ' +
        'would fall back to STUN-only with no relay, which fails on ' +
        'symmetric / carrier-grade NAT.',
    );
  }

  if (!env.ADMIN_TOKEN) {
    errors.push(
      'ADMIN_TOKEN is missing — the admin and @speaker broadcast endpoints ' +
        'reject every request (503) without it.',
    );
  }

  if (env.METRICS_ENABLED === '1' && !env.METRICS_TOKEN) {
    errors.push(
      'METRICS_ENABLED=1 but METRICS_TOKEN is missing — /metrics is mounted ' +
        'on the public listener and would refuse every scrape (503).',
    );
  }

  return errors;
}

/**
 * Throw `ProductionConfigError` if the process is a production deployment
 * with any unsafe fallback configuration. No-op outside production.
 */
export function assertProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProductionEnv(env)) return;
  const errors = collectProductionConfigErrors(env);
  if (errors.length > 0) {
    throw new ProductionConfigError(errors);
  }
}
