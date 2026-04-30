import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Static-analysis lint that prevents the bug class where mobile runtime
 * code reaches for a Node/Web global that Hermes (RN's release JS engine)
 * doesn't ship. We've shipped this bug TWICE so far:
 *
 *   - 0.2.1: `Buffer.from(...)` — Node global, missing in Hermes.
 *     User-visible: `[send failed: Buffer doesn't exist]`.
 *   - 0.2.4: `new TextDecoder('utf-8').decode(...)` — supposedly in
 *     Hermes 0.74+, NOT in our actual on-device build.
 *     User-visible: silent self-DM drop (every received message vanished).
 *
 * Routing every byte/string conversion through `apps/mobile/src/utils/bytes.ts`
 * (which uses only `String.fromCharCode`, manual UTF-8, and `btoa`/`atob`)
 * gives us one place to maintain the policy. THIS test fails CI if any
 * other runtime file mentions a banned global as a method call or
 * constructor invocation.
 */

const BANNED = [
  // pattern, friendly description, why it's banned
  {
    pattern: '\\bBuffer\\.[a-zA-Z]|new[[:space:]]+Buffer\\(',
    name: 'Buffer',
    why: 'Node-only; Hermes does not ship it. Use utils/bytes helpers.',
  },
  {
    pattern: '\\bnew[[:space:]]+TextDecoder\\b',
    name: 'TextDecoder',
    why: 'Missing on the actual Hermes runtime despite docs claims. Use utf8FromBytes.',
  },
  {
    pattern: '\\bnew[[:space:]]+TextEncoder\\b',
    name: 'TextEncoder',
    why: 'Missing on the actual Hermes runtime despite docs claims. Use utf8ToBytes.',
  },
];

describe('no Hermes-banned globals in mobile runtime', () => {
  for (const { pattern, name, why } of BANNED) {
    it(`runtime code never reaches for ${name} (${why})`, () => {
      let stdout = '';
      try {
        stdout = execSync(
          `grep -rlE '${pattern}' src ` +
            '--include="*.ts" --include="*.tsx" ' +
            '--exclude="*.test.ts" --exclude="*.test.tsx"',
          { cwd: __dirname.replace(/\/src\/integration$/, ''), encoding: 'utf8' },
        );
      } catch (e) {
        const err = e as { status?: number };
        // grep exits 1 with no matches — that's the green path.
        if (err.status === 1) return;
        throw e;
      }
      const offenders = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        // utils/bytes.ts may legitimately reference the banned name in
        // comments explaining why it doesn't use it. Pattern is anchored
        // to actual usage so this exemption rarely matters in practice.
        .filter((l) => !l.includes('src/utils/bytes.ts'))
        // Integration harness imports from outside the mobile rootDir
        // and may reference Node globals the harness itself uses.
        .filter((l) => !l.startsWith('src/integration/'));
      expect(
        offenders,
        `mobile runtime files using ${name} (banned: ${why}):\n  ` +
          offenders.join('\n  '),
      ).toEqual([]);
    });
  }
});
