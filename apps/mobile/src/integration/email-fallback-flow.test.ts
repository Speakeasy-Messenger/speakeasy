/**
 * Guard the three Maestro-level bugs that cost real device runs while
 * proving the email-OTP fallback (see `maestro/EMAIL_FALLBACK_EVIDENCE.md`).
 * All three were silent: the app behaved correctly and the run still failed,
 * or failed while blaming the wrong component.
 *
 * The load-bearing one is variable scoping. Verified against Maestro 2.5.1
 * by running a parent flow with two sub-flows and reporting what each saw:
 *
 *   parent (env: OTP_URL: PARENT_PATCHED)           -> PARENT_PATCHED
 *   sub-flow WITH its own `env: OTP_URL: ''`        -> ''      (!)
 *   sub-flow with NO `env:` block                   -> PARENT_PATCHED
 *
 * i.e. a sub-flow's declared default BEATS the value passed to it through
 * `runFlow: env:` — it shadows rather than defaults. `_email-fallback-otp.yaml`
 * declared `OTP_URL: ''`, so OTP_URL was always empty inside it, the poll
 * loop's `OTP_URL !== ''` guard was never true, the whole `repeat` was
 * skipped, and the run died asserting "no code arrived" while the relay
 * held a perfectly good code.
 *
 * These are string checks on the flow files on purpose: the thing being
 * guarded is the YAML, and nothing else in the suite reads it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const maestroRoot = resolve(__dirname, '../../maestro');
const read = (name: string) => readFileSync(resolve(maestroRoot, name), 'utf8');

const parent = read('13-email-fallback-enroll-ios.yaml');
const subflow = read('_email-fallback-otp.yaml');

/** Everything above the `---` separator: the flow's config block. */
const header = (flow: string) => flow.split(/^---$/m)[0];

describe('email-fallback Maestro flows', () => {
  it('the OTP sub-flow declares no env block, so nothing shadows the caller', () => {
    // A re-added `env:` here reads as harmless — "just defaults" — and
    // silently disables the entire OTP fetch. Values reach this flow only
    // through the parent's `runFlow: env:`.
    expect(header(subflow)).not.toMatch(/^env:/m);
  });

  it('the parent passes both OTP inputs into the sub-flow explicitly', () => {
    // Without these, the sub-flow sees the variables as undefined rather
    // than inheriting them: Maestro sub-flows inherit nothing.
    const runFlow = parent.slice(parent.indexOf('file: _email-fallback-otp.yaml'));
    expect(runFlow).toMatch(/env:/);
    expect(runFlow).toMatch(/OTP_URL:\s*\$\{OTP_URL\}/);
    expect(runFlow).toMatch(/FALLBACK_OTP:\s*\$\{FALLBACK_OTP\}/);
  });

  it('the parent declares the env keys the runner patches', () => {
    // `browserstack-ios-fallback.sh` rewrites these lines by exact prefix
    // match; a renamed or dropped key makes the patch a silent no-op.
    for (const key of ['HANDLE', 'FALLBACK_EMAIL', 'FALLBACK_OTP', 'OTP_URL']) {
      expect(header(parent)).toMatch(new RegExp(`^  ${key}:`, 'm'));
    }
  });

  it('text assertions match the full element text', () => {
    // Maestro text matchers are regexes anchored to an element's ENTIRE
    // text. `'We sent a code to'` failed against "We sent a code to
    // <addr>. Enter it to finish." with the right screen on display.
    const bare = [...parent.matchAll(/^- assertVisible: '([^']+)'$/gm)].map((m) => m[1]);
    expect(bare.length).toBeGreaterThan(0);
    for (const pattern of bare) {
      expect(
        pattern.endsWith('.*'),
        `assertVisible '${pattern}' must end with .* to match the full element text`,
      ).toBe(true);
    }
  });
});
