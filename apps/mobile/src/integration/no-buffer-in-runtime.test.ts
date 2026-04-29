import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Static-analysis test. Catches the bug class that shipped 0.2.1: a
 * mobile-runtime module reaching for `Buffer` (a Node global Hermes
 * doesn't ship). The fix added `apps/mobile/src/utils/bytes.ts` and
 * routed every byte/string/base64 conversion through it; this test
 * locks that policy in by failing CI if any non-test, non-utils file
 * under `src/` references `Buffer`.
 *
 * Cheap enough (single grep) that it's worth running on every push.
 */

describe('no Buffer references in mobile runtime', () => {
  it('only utils/bytes.ts is allowed to mention Buffer (and only in comments)', () => {
    // -l: list files only. -F: literal string. Recursive over src/.
    // Excluded:
    //   - tests (.test.ts) — they may delete Buffer for setup, comment on it
    //   - src/utils/bytes.ts — the comment explicitly references Buffer
    //   - src/integration/ — harness intentionally documents the rule
    // Look for actual uses (Buffer.from / Buffer.alloc / Buffer.isBuffer
    // / `new Buffer(`) — not comment-only mentions of the word.
    let stdout = '';
    try {
      stdout = execSync(
        "grep -rlE '(\\bBuffer\\.[a-zA-Z]|new[[:space:]]+Buffer\\()' src " +
          '--include="*.ts" --include="*.tsx" ' +
          '--exclude="*.test.ts" --exclude="*.test.tsx"',
        { cwd: __dirname.replace(/\/src\/integration$/, ''), encoding: 'utf8' },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      // grep exits 1 with no matches — that's the green path.
      if (err.status === 1) return;
      throw e;
    }
    const offenders = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.includes('src/utils/bytes.ts'))
      .filter((l) => !l.startsWith('src/integration/'));
    expect(
      offenders,
      'mobile runtime files referencing `Buffer` (Hermes does not ship it):\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
