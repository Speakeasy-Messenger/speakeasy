#!/usr/bin/env node
/**
 * Iteration-loop driver for the avatar expressivity harness.
 *
 * The loop the user asked for: instead of giving repeated hand
 * feedback ("the face is too flat"), point a coding subagent at a
 * scored harness and let it work to a target. This script is the
 * harness side of that loop — it scores, picks the next target, gates
 * regressions, and protects itself from being gamed. The *agent* side
 * (whoever edits the Renders) is pluggable: a human pasting the prompt
 * into a subagent, or an `--exec` command that runs one headlessly.
 *
 * Commands (run from apps/mobile):
 *   node src/avatars/expressivity/harness/iterate.mjs score
 *       Run the harness, (re)write out/*.json, print the headline +
 *       worst cells, and say whether the target is met.
 *   node src/avatars/expressivity/harness/iterate.mjs next
 *       Print the task prompt for the next subagent iteration —
 *       the single worst (animal, dead-channel/region) cell, the files
 *       it may edit, and the rules it must obey.
 *   node src/avatars/expressivity/harness/iterate.mjs gate
 *       Compare the latest score against the snapshot saved by the
 *       previous `score`, and FAIL (exit 1) on any metric regression
 *       or any edit to a frozen harness/corpus file.
 *   node src/avatars/expressivity/harness/iterate.mjs loop [--max N] [--exec "<cmd>"]
 *       Run the full cycle: score → snapshot → next → run the agent
 *       (--exec, or pause for a manual edit) → score → gate → repeat
 *       until the target is met or N iterations elapse.
 *
 * WHY a driver and not just a Workflow: the harness must stay frozen
 * relative to the agent (otherwise "passing" is achievable by editing
 * the metric), the loop must hard-gate regressions, and the target is
 * multi-dimensional (signal stays healthy AND face coverage climbs AND
 * the eyes gap closes AND no flat outliers remain). Encoding that here
 * makes the loop reproducible and agent-agnostic.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HARNESS_DIR, '..'); // .../expressivity
const OUT = join(ROOT, 'out');
const MOBILE = join(ROOT, '..', '..', '..'); // apps/mobile
const TEST_REL = relative(MOBILE, join(ROOT, 'expressivity.test.ts'));
const SCORECARD = join(OUT, 'harness-scorecard.json');
const PREV = join(OUT, 'harness-scorecard.prev.json');
const FREEZE_HASH = join(OUT, 'freeze.sha256');

/**
 * The success target. The loop stops when ALL hold. Tune as you go;
 * raising tier2Overall / minPerAnimal is how you ask for more.
 */
const TARGET = {
  tier1Overall: 0.85, // signal stays healthy (guard — never trade this away)
  tier2Overall: 0.85, // rendered-face coverage climbs from the 0.54 baseline
  eyesExpressiveFraction: 0.8, // close the "no eyes" gap across animals
  loudnessReactiveFraction: 0.8, // animals visibly react to a sustained yell
  minPerAnimalScore: 0.6, // no flat outliers (pigeon/octopus are 0.35 today)
};

/**
 * Files the agent may NOT touch — the metric and its inputs. Editing
 * these is how a loop cheats ("pass" by moving the goalposts), so the
 * gate hashes them and fails if they change. Everything the agent IS
 * meant to edit (components.tsx, rares/*, AvatarRenderer.tsx) is
 * deliberately absent.
 */
const FROZEN = [
  'harness/tier2.ts',
  'harness/metrics.ts',
  'harness/run-pipeline.ts',
  'harness/scorecard.ts',
  'corpus/synth.ts',
  'corpus/index.ts',
  'expressivity.test.ts',
];

function hashFrozen() {
  const h = createHash('sha256');
  for (const rel of FROZEN) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(ROOT, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function runHarness() {
  // The test writes out/harness-scorecard.json + tier2-scorecard.json.
  // Run just that file; quiet unless it fails.
  execSync(`npx vitest run ${TEST_REL}`, { cwd: MOBILE, stdio: 'inherit' });
  return JSON.parse(readFileSync(SCORECARD, 'utf8'));
}

function readScore() {
  if (!existsSync(SCORECARD)) return runHarness();
  return JSON.parse(readFileSync(SCORECARD, 'utf8'));
}

function targetStatus(sc) {
  const worstAnimal = Math.min(...sc.tier2.perAnimal.map((p) => p.score));
  const checks = {
    'tier1.overall': [sc.tier1.overall, TARGET.tier1Overall],
    'tier2.overall': [sc.tier2.overall, TARGET.tier2Overall],
    eyesExpressiveFraction: [
      sc.tier2.eyesExpressiveFraction,
      TARGET.eyesExpressiveFraction,
    ],
    loudnessReactiveFraction: [
      sc.tier2.loudnessReactiveFraction,
      TARGET.loudnessReactiveFraction,
    ],
    'min per-animal score': [worstAnimal, TARGET.minPerAnimalScore],
  };
  const rows = Object.entries(checks).map(([k, [got, want]]) => ({
    k,
    got,
    want,
    ok: got >= want,
  }));
  return { rows, met: rows.every((r) => r.ok) };
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(3) : String(n);
}

function cmdScore() {
  const sc = runHarness();
  // Snapshot for the regression gate + freeze hash for anti-gaming.
  writeFileSync(PREV, JSON.stringify(sc, null, 2));
  writeFileSync(FREEZE_HASH, hashFrozen());
  const { rows, met } = targetStatus(sc);
  console.log(`\n=== expressivity harness ===`);
  console.log(`combined overall : ${fmt(sc.overall)}`);
  for (const r of rows) {
    console.log(`  [${r.ok ? 'OK ' : '   '}] ${r.k.padEnd(24)} ${fmt(r.got)}  (target ${fmt(r.want)})`);
  }
  console.log(`\nweakest animals (call-time Render):`);
  for (const p of sc.tier2.perAnimal.slice(0, 5)) {
    console.log(
      `  ${p.animalId.padEnd(9)} score ${fmt(p.score)}  dead:[${p.deadChannels.join(',')}]  missing-regions:[${p.missingRegions.join(',')}]`,
    );
  }
  console.log(met ? `\n✅ TARGET MET` : `\n→ not yet — run \`next\` for the iteration prompt`);
  process.exit(met ? 0 : 0);
}

/** Build the task prompt for the next subagent iteration. */
function cmdNext() {
  const sc = readScore();
  const { met } = targetStatus(sc);
  if (met) {
    console.log('TARGET MET — no further iteration needed.');
    return;
  }
  // Worst animal first; within it, name the dead channels + regions.
  const worst = sc.tier2.perAnimal[0];
  const eyesGap = sc.tier2.eyesExpressiveFraction < TARGET.eyesExpressiveFraction;
  const yellGap = sc.tier2.loudnessReactiveFraction < TARGET.loudnessReactiveFraction;
  const prompt = `TASK — raise avatar facial expressivity for "${worst.animalId}" (private-call Render).

Context: an automated harness scores how much the peer's voice prosody
moves each avatar's face during a Private Call. "${worst.animalId}" is the
weakest: score ${fmt(worst.score)} (call Render "${worst.renderName}").

It currently drops these channels (handed to the Render, never wired to
motion): ${worst.deadChannels.join(', ') || '(none)'}
And these facial regions never move: ${worst.missingRegions.join(', ') || '(none)'}
${eyesGap ? '\nGLOBAL GAP: no animal moves the EYES on emotion (eyes are blink-timer only). Wiring an emotion channel to an eye transform — widen on gasp/excited, narrow on yell, soften on sad — is the highest-value fix.\n' : ''}${yellGap ? '\nGLOBAL GAP: no animal reacts to a YELL (sustained loudness). The mouth already scales with amplitude, but nothing recoils/braces/widens on a shout. Wire the `amplitude` prop (or prosody?.amplitude) into a NON-mouth pose — a head recoil/lean, brow raise, or eye widen on high amplitude (name the var e.g. `recoil`/`loudBrace`). This is what "react when the user is yelling" needs.\n' : ''}
Do this:
  1. Edit ONLY apps/mobile/src/avatars/components.tsx (the per-animal
     Render / RenderCall) — and AvatarRenderer.tsx if you need a new
     shared motion helper. Use FoxCall (components.tsx) as the
     reference for a rich Render: it wires pitchTrend→ears,
     expressiveness→brow, activity→cheeks, mouthShape→mouth.
  2. Wire each dead channel above into a transform on a real facial
     feature via prosody?.<channel>.interpolate(...). Add an
     emotion-driven eye transform if the eyes are dead.
  3. Re-run: \`node src/avatars/expressivity/harness/iterate.mjs score\`
     from apps/mobile.

RULES (the gate enforces these):
  - Do NOT edit anything under expressivity/harness/, expressivity/corpus/,
    or expressivity.test.ts. Those are the metric; changing them fails
    the gate.
  - Do NOT lower any other animal's score or tier1.overall. The gate
    rejects regressions.
  - Keep the brand constraints (3 colors, react-native-svg, the
    AnimalBody hook-order invariant — pure SVG, no per-animal hooks).`;
  console.log(prompt);
}

/** Regression gate: latest vs the snapshot from the previous score. */
function cmdGate() {
  if (!existsSync(PREV)) {
    console.error('No previous snapshot — run `score` first.');
    process.exit(2);
  }
  // Anti-gaming: the frozen metric files must be byte-identical.
  if (existsSync(FREEZE_HASH)) {
    const want = readFileSync(FREEZE_HASH, 'utf8').trim();
    if (hashFrozen() !== want) {
      console.error('❌ GATE FAIL: a frozen harness/corpus file changed. The metric must not be edited by the agent.');
      process.exit(1);
    }
  }
  const cur = runHarness();
  const prev = JSON.parse(readFileSync(PREV, 'utf8'));
  const regressions = [];
  if (cur.tier1.overall + 1e-9 < prev.tier1.overall)
    regressions.push(`tier1.overall ${fmt(prev.tier1.overall)} → ${fmt(cur.tier1.overall)}`);
  const prevByAnimal = Object.fromEntries(prev.tier2.perAnimal.map((p) => [p.animalId, p.score]));
  for (const p of cur.tier2.perAnimal) {
    const was = prevByAnimal[p.animalId];
    if (was !== undefined && p.score + 1e-9 < was)
      regressions.push(`${p.animalId} ${fmt(was)} → ${fmt(p.score)}`);
  }
  if (regressions.length) {
    console.error('❌ GATE FAIL — regressions:\n  ' + regressions.join('\n  '));
    process.exit(1);
  }
  const dTier2 = cur.tier2.overall - prev.tier2.overall;
  console.log(`✅ GATE PASS — no regressions. tier2.overall ${fmt(prev.tier2.overall)} → ${fmt(cur.tier2.overall)} (${dTier2 >= 0 ? '+' : ''}${fmt(dTier2)})`);
  // Advance the snapshot so the next iteration gates against this one.
  writeFileSync(PREV, JSON.stringify(cur, null, 2));
}

function cmdLoop(args) {
  const max = Number(args[args.indexOf('--max') + 1]) || 8;
  const execIdx = args.indexOf('--exec');
  const exec = execIdx >= 0 ? args[execIdx + 1] : undefined;
  for (let i = 1; i <= max; i++) {
    const sc = runHarness();
    writeFileSync(PREV, JSON.stringify(sc, null, 2));
    writeFileSync(FREEZE_HASH, hashFrozen());
    const { met } = targetStatus(sc);
    console.log(`\n— iteration ${i}/${max} — combined ${fmt(sc.overall)} — ${met ? 'TARGET MET' : 'continuing'}`);
    if (met) {
      console.log('✅ done.');
      return;
    }
    cmdNext();
    if (!exec) {
      console.log('\n(no --exec: make the edit above, then re-run `loop` to continue.)');
      return;
    }
    // Hand the prompt to the agent CLI on stdin; it edits the tree.
    const prompt = execSync(`node ${join(HARNESS_DIR, 'iterate.mjs')} next`, { cwd: MOBILE }).toString();
    execSync(exec, { cwd: MOBILE, input: prompt, stdio: ['pipe', 'inherit', 'inherit'] });
    // Gate the agent's edit; a regression or frozen-file change aborts.
    try {
      execSync(`node ${join(HARNESS_DIR, 'iterate.mjs')} gate`, { cwd: MOBILE, stdio: 'inherit' });
    } catch {
      console.error('Aborting loop: the last edit failed the gate.');
      return;
    }
  }
  console.log(`\nReached --max ${max} without meeting target. Inspect out/harness-scorecard.json.`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'score':
    cmdScore();
    break;
  case 'next':
    cmdNext();
    break;
  case 'gate':
    cmdGate();
    break;
  case 'loop':
    cmdLoop(rest);
    break;
  default:
    console.log('usage: iterate.mjs <score|next|gate|loop> [--max N] [--exec "<agent cmd>"]');
    process.exit(2);
}
