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

/**
 * Workspace packages bundled into the mobile app. Each gets the same
 * lint applied. The 0.2.7 alpha shipped a `Buffer.from` in
 * @speakeasy/crypto that this lint missed because it only scanned
 * apps/mobile/src — bug class repeated, that's on us.
 */
const SCOPES = [
  { cwd: 'apps/mobile', src: 'src', exempt: ['src/utils/bytes.ts'] },
  // @speakeasy/crypto is bundled directly. Server-only files
  // (software-channel-key.ts uses node:crypto) are exempt explicitly.
  {
    cwd: 'packages/crypto',
    src: 'src',
    exempt: ['src/bytes.ts', 'src/software-channel-key.ts'],
  },
  { cwd: 'packages/shared', src: 'src', exempt: [] },
];

const monorepoRoot = __dirname.replace(/\/apps\/mobile\/src\/integration$/, '');

describe('no Hermes-banned globals in any mobile-bundled workspace package', () => {
  for (const scope of SCOPES) {
    for (const { pattern, name, why } of BANNED) {
      it(`${scope.cwd}: never uses ${name} (${why})`, () => {
        let stdout = '';
        try {
          stdout = execSync(
            `grep -rlE '${pattern}' ${scope.src} ` +
              '--include="*.ts" --include="*.tsx" ' +
              '--exclude="*.test.ts" --exclude="*.test.tsx"',
            { cwd: `${monorepoRoot}/${scope.cwd}`, encoding: 'utf8' },
          );
        } catch (e) {
          const err = e as { status?: number };
          if (err.status === 1) return;
          throw e;
        }
        const offenders = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .filter((l) => !scope.exempt.includes(l))
          .filter((l) => !l.startsWith('src/integration/'));
        expect(
          offenders,
          `${scope.cwd} files using ${name} (banned: ${why}):\n  ` +
            offenders.join('\n  '),
        ).toEqual([]);
      });
    }
  }
});
