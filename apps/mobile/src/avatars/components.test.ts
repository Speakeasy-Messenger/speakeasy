/**
 * Catalog-shape integrity tests for the rc.12 call-mask variants.
 *
 * We can't `import { ANIMALS }` from components.tsx at runtime —
 * the file transitively pulls in react-native-svg + reanimated,
 * neither of which has a vitest mock in this workspace (adding
 * them would be substantially more test infrastructure than the
 * invariant is worth). Following the same source-level pattern
 * as `AvatarRenderer.regression.test.ts`, this test reads the
 * components.tsx file as text and asserts the catalog wires every
 * free-common animal to a `RenderCall` + `callAnchors`.
 *
 * Catches the most common regression: forgetting to wire
 * `RenderCall: XCall` on a new animal, or accidentally pointing
 * both `Render` and `RenderCall` at the same function (which
 * would silently disable the expressive variant in call surfaces).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FREE_COMMONS = [
  'fox',
  'owl',
  'pigeon',
  'hare',
  'stag',
  'whale',
  'moth',
  'octopus',
  'heron',
  'bear',
  'cat',
  'bat',
] as const;

const SRC = readFileSync(
  new URL('./components.tsx', import.meta.url),
  'utf8',
);

/**
 * For an animal id, extract its `ANIMALS` catalog entry as a
 * substring. Anchors against `^  <id>: {` (2-space indent + colon)
 * and walks forward to the matching `^  },` (the closing brace of
 * the entry at the same indent). Lazy/non-greedy matching keeps
 * the entry scoped to the right one even when later entries
 * reference the same animal name in comments.
 */
function entryFor(id: string): string {
  const re = new RegExp(`^  ${id}: \\{[\\s\\S]*?^  \\},`, 'm');
  const match = re.exec(SRC);
  if (!match) throw new Error(`could not locate ANIMALS catalog entry for ${id}`);
  return match[0];
}

describe('ANIMALS — free commons have call-mask variants', () => {
  it.each(FREE_COMMONS)('%s ships a RenderCall reference', (id) => {
    const entry = entryFor(id);
    // Expect a line like `    RenderCall: FoxCall,`
    expect(entry, `${id} entry should have a RenderCall field`).toMatch(
      /RenderCall:\s*\w+Call\b/,
    );
  });

  it.each(FREE_COMMONS)('%s ships callAnchors with all 5 anchor fields', (id) => {
    const entry = entryFor(id);
    expect(entry).toMatch(/callAnchors:\s*\{/);
    // Pull out the callAnchors block and assert each anchor name.
    const callAnchorsMatch =
      /callAnchors:\s*\{([\s\S]*?)^\s*\},/m.exec(entry);
    expect(
      callAnchorsMatch,
      `${id} callAnchors block should be parseable`,
    ).not.toBeNull();
    const block = callAnchorsMatch![1]!;
    expect(block).toMatch(/breathePivot:/);
    expect(block).toMatch(/eyeLeftPivot:/);
    expect(block).toMatch(/eyeRightPivot:/);
    expect(block).toMatch(/mouthPivot:/);
    expect(block).toMatch(/mouthAxis:\s*'[xy]'/);
  });

  it.each(FREE_COMMONS)('%s Render and RenderCall point to DIFFERENT functions', (id) => {
    const entry = entryFor(id);
    const renderMatch = /^\s+Render:\s*(\w+),\s*$/m.exec(entry);
    const renderCallMatch = /^\s+RenderCall:\s*(\w+),\s*$/m.exec(entry);
    expect(renderMatch, `${id} should have a Render: line`).not.toBeNull();
    expect(renderCallMatch, `${id} should have a RenderCall: line`).not.toBeNull();
    const renderName = renderMatch![1]!;
    const renderCallName = renderCallMatch![1]!;
    // If a future refactor accidentally aliases both keys to the
    // same function, the call surface would render the minimalist
    // default and we'd silently lose the expressive variant. This
    // test trips loudly when that happens.
    expect(
      renderName,
      `${id}: Render and RenderCall reference the same function — call surface won't get the expressive variant`,
    ).not.toBe(renderCallName);
  });
});

describe('ANIMALS — paid tiers fall through to default Render', () => {
  // The paid catalog entries are built via `paidDef(...)` which
  // doesn't accept a RenderCall — call surfaces will render the
  // default `Render` for those animals until they get a call mask
  // of their own.
  it('no paid entry wires a RenderCall yet', () => {
    // Match any animal entry registered via `paidDef(...)`.
    const paidEntries = SRC.match(/\bpaidDef\(/g) ?? [];
    expect(paidEntries.length).toBeGreaterThan(0);
    // The paidDef factory doesn't currently set RenderCall on the
    // built AnimalDef. If a future refactor adds that, this test
    // breaks visibly and the maintainer updates accordingly.
    const paidDefBody =
      /function paidDef\([\s\S]*?^\}/m.exec(SRC);
    expect(paidDefBody).not.toBeNull();
    expect(paidDefBody![0]).not.toMatch(/RenderCall:/);
  });
});
