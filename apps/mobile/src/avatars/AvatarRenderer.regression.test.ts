/**
 * AvatarRenderer / AnimalBody regression — rc.6 fox-crash hotfix.
 *
 * Per-animal Render functions declare different hook counts (Fox +
 * Hawk: 4 via useEmotionDrive; Raven: 7 with the existing head-bob;
 * free commons: 0). Hooks called inside a per-animal Render attribute
 * to whichever fiber invokes the Render function. If a long-lived
 * fiber renders different animals over time (avatar picker save,
 * AvatarCacheWarmer's userId+animal queue, deterministic-default →
 * saved-profile transitions on app launch), the fiber's hook count
 * changes between renders and React crashes the app with "Rendered
 * more hooks than during the previous render."
 *
 * `AnimalBody` (in components.tsx) encapsulates the fix: it mounts
 * an inner `RenderHost` keyed on `animalId`, so animal changes
 * force a clean unmount + remount and the new fiber starts fresh.
 *
 * This file holds two invariants worth catching at CI time:
 *
 *  1. Only `components.tsx` may call `def.Render(...)` directly.
 *     Every other consumer must mount `<AnimalBody ... />` instead.
 *     The first version of this fix only patched `AnimalSvg` and
 *     left `AvatarCacheWarmer` inlined — bananaman4's app still
 *     crashed on rc.8 because the warmer hits the same code path
 *     for every (userId, animalId) it rasterizes for notifications.
 *  2. `AnimalBody`'s inner mount must be keyed on `animalId`.
 *     That's the actual load-bearing piece of the fix.
 *
 * If a future refactor restructures the avatars module, update this
 * test to assert the new shape — don't delete it without first
 * confirming the equivalent invariant lives somewhere else.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AVATARS_DIR = new URL('./', import.meta.url).pathname;

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (
      stat.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      files.push(full);
    }
  }
  return files;
}

describe('AnimalBody encapsulates def.Render', () => {
  it('no source outside components.tsx invokes def.Render directly', () => {
    // Search the entire mobile src tree so a future call site shows
    // up before it ships. components.tsx is the only legal location
    // (AnimalBody's internal RenderHost lives there).
    const SRC_ROOT = new URL('../', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const content = readSource(file);
      if (!/\.Render\s*\(/.test(content)) continue;
      // Allow components.tsx — that's where AnimalBody / RenderHost
      // are defined and own the keyed invocation.
      if (file.endsWith('/avatars/components.tsx')) continue;
      // Skip false-positive matches on `.Render` that aren't the
      // per-animal pattern (e.g. unrelated module APIs would still
      // need to be reviewed). We require the call to look like a
      // catalog-dispatch shape.
      if (
        /(?:ANIMALS\[[^\]]+\]|def|animalDef)\.Render\s*\(/.test(content)
      ) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Move these direct def.Render(...) calls behind <AnimalBody ...>: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('AnimalBody mounts its render output behind a key that includes animalId', () => {
    // The key sits on its own line inside the AnimalBody → RenderHost
    // JSX, e.g.:
    //
    //     key={`${animalId}-${useCallMask ? 'call' : 'default'}`}
    //
    // Pattern-match the line non-greedily until the prop-closing `}`
    // followed by end-of-line. Template-literal nesting (which
    // contains its own `}` chars) is handled by anchoring against
    // `\s*$` (the prop close is the last `}` on the line).
    const src = readSource(join(AVATARS_DIR, 'components.tsx'));
    const bodyMatch =
      /export function AnimalBody\b[\s\S]*?<RenderHost[\s\S]*?\/>/.exec(src);
    expect(bodyMatch, 'expected an AnimalBody → RenderHost element').not.toBeNull();
    const renderHostBlock = bodyMatch![0];
    const keyLine = /key=\{(.+?)\}\s*$/m.exec(renderHostBlock);
    expect(keyLine, 'expected a `key=` prop on RenderHost').not.toBeNull();
    const keyExpr = keyLine![1]!;
    expect(
      keyExpr,
      'AnimalBody key must reference animalId — that\'s the per-animal hook-order discriminator',
    ).toContain('animalId');
  });

  it('AnimalBody key also distinguishes the call-mask variant from the default Render', () => {
    // rc.12 invariant: when an animal has both `Render` and
    // `RenderCall`, swapping between them MUST change the key so React
    // unmounts the prior fiber and starts the new variant with a fresh
    // hook order. Without this, a Render variant that calls more hooks
    // than the default (e.g. an animated jaw-shape interpolation in
    // the call mask but not the static default) would re-introduce the
    // rc.6 fox-crash class of bug the moment a peer placed a call.
    //
    // The assertion pattern-matches the key for a non-`animalId`
    // discriminator — typically `useCallMask`, `renderForCall`, or a
    // string suffix like 'call'/'default' interpolated alongside the
    // id.
    const src = readSource(join(AVATARS_DIR, 'components.tsx'));
    const bodyMatch =
      /export function AnimalBody\b[\s\S]*?<RenderHost[\s\S]*?\/>/.exec(src);
    expect(bodyMatch).not.toBeNull();
    const renderHostBlock = bodyMatch![0];
    const keyLine = /key=\{(.+?)\}\s*$/m.exec(renderHostBlock);
    expect(keyLine).not.toBeNull();
    const keyExpr = keyLine![1]!;
    expect(
      keyExpr,
      "AnimalBody key must include a variant discriminator beyond animalId — currently `${animalId}-${... call/default ...}`",
    ).toMatch(/call|render|variant|mask/i);
  });
});
