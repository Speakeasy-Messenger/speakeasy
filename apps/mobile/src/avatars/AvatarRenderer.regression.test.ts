/**
 * AvatarRenderer regression — rc.6 fox-crash hotfix.
 *
 * Per-animal `Render` functions are invoked via direct call inside
 * `AnimalSvg` (`def.Render({...})`), so any hooks they declare
 * attribute to `AnimalSvg`'s fiber rather than to a per-animal
 * fiber. Different animals declare different hook counts (Hawk's
 * BeakScan worklet + emotion drive, Raven's head-bob + ruffle,
 * Fox's ear-drive, vs free commons with no hooks). When the
 * `animalId` prop on a single `AnimalSvg` instance changes — which
 * happens routinely after a picker save, and on every relaunch
 * (avatar slot renders with `defaultAnimalForUser` fallback before
 * the saved profile loads) — the fiber's hook-order check breaks
 * and Hermes crashes the app on release builds.
 *
 * The cure is `key={animalId}` on the `AnimalSvg` mounted from
 * `AvatarRenderer`, which forces a clean unmount + remount when
 * the avatar changes. This invariant is one line easy to lose in
 * a refactor; the test ensures any removal trips loudly.
 *
 * If a future change moves `AnimalSvg` behind a wrapper that owns
 * the key invariant somewhere else, update this test to assert
 * the new shape — don't just delete it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RENDERER_SRC = readFileSync(
  new URL('./AvatarRenderer.tsx', import.meta.url),
  'utf8',
);

describe('AvatarRenderer hook-stability invariant', () => {
  it('keys AnimalSvg on animalId to force remount on avatar change', () => {
    const animalSvgUsage = /<AnimalSvg\b[^>]*>/s.exec(RENDERER_SRC);
    expect(animalSvgUsage, 'expected an <AnimalSvg ...> JSX usage').not.toBeNull();
    expect(animalSvgUsage![0]).toMatch(/\bkey=\{animalId\}/);
  });
});
