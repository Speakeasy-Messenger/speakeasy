import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Wiring guard for the September 2026 Android verification lockout.
 *
 * `lake-late-trout` sat in a permanent "Verify this device" loop: the
 * device's last Vouchflow verification aged past the server's 30-day
 * freshness window, the client correctly decided to re-verify, but the
 * re-verification never reached the native SDK — the app's global
 * client was a `CachingVouchflowClient`, which could answer `verify()`
 * from a cached success. The stale credential was re-presented, the
 * server rejected it again, and zero verification rows were created.
 *
 * These tests exist so the caching layer cannot come back by accident.
 * `src/auth/stale-verification-recovery.test.ts` proves the recovery
 * behaviour against a bare client; THIS file is what pins the app's
 * production wiring to that same bare client.
 */

const mobileSrc = path.resolve(__dirname, '..');

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__mocks__') continue;
      productionFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe('Vouchflow client wiring', () => {
  it('wires the app-wide client straight to the native SDK — no interposed layer', () => {
    const services = readFileSync(path.join(mobileSrc, 'services.ts'), 'utf8');
    const decl = /export const vouchflow[^=]*=\s*([\s\S]*?);/.exec(services);
    expect(decl, 'services.ts must export a `vouchflow` const').not.toBeNull();

    const initializer = decl![1]!
      .replace(/\s+/g, ' ')
      .replace(/,\s*\)/g, ')')
      .trim();
    // Anything between the app and `NativeVouchflowClient` can answer
    // verify() without the SDK — which is exactly the lockout.
    expect(initializer).toBe('new NativeVouchflowClient()');
  });

  it('has exactly one production implementation of VouchflowClient', () => {
    const implementers = productionFiles(mobileSrc)
      .filter((f) => /implements\s+VouchflowClient\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(mobileSrc, f))
      .sort();

    // A second implementation is how a cache/memo wrapper gets back in:
    // it satisfies the interface, so every call site keeps compiling
    // while forced re-verification silently stops reaching the SDK.
    expect(implementers).toEqual(['native/vouchflow.ts']);
  });
});
