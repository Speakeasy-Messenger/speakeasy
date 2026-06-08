# Avatar expressivity harness

An evaluation harness for how expressive the avatars are during Private
Calls, plus an iteration loop that lets a coding subagent work toward a
target instead of you giving repeated hand feedback ("the face is too
flat").

It exists because the feedback loop was the bottleneck: the visible
problem ("mouth flits sideways, no eyes, no expression on laugh/yell")
is real but tedious to re-describe each round. A scored harness turns
"looks dead" into numbers a subagent can optimize against.

## Two tiers

**Tier-1 — does the signal exist?** Drives the synthetic corpus through
the *real* production feature pipeline (`audio-feature-extractor` →
`acoustic-event-detector`) and scores the animation parameters on
discriminability (can a classifier recover the emotion), per-label
signatures (does laugh→event fire, yell→loud, question→pitch rises…),
and liveliness (which channels actually move). This guards against
optimizing motion that's driven by noise.

**Tier-2 — does the rendered face move?** This is the layer the user
actually sees. For each animal's call-time `Render` in `components.tsx`
it measures, statically, which prosody channels (`pitchTrend`,
`expressiveness`, `activity`, `mouthShape`) reach a transform and which
facial regions (head, brow, eyes, mouth, cheek) move. Coverage is uneven
(FoxCall wires all four channels; pigeon/octopus only move the mouth).
The original headline gap — **no animal moved the eyes on emotion** (the
eyes were blink-timer only, `eyesExpressiveFraction = 0`) — was closed by
the rc.58 `ExprEyes` redesign: the shared eyes now blow wide with the
peer's loudness and every call-time `Render` wires them up. (The discrete
laugh-squint eye pose is disabled since rc.83 — see `LAUGH_SQUINT_ENABLED`
in `components.tsx` — so it no longer contributes to the eyes score.)

> **What Tier-2 does NOT measure:** magnitude or aesthetics. `react-native`
> is mocked in vitest (no Animated/SVG, no rasterizer), so we can't render
> off-device — Tier-2 scores *wiring*, not how far a feature moves or how
> good it looks. Magnitude is guarded by Tier-1 (the signal has range) and
> by the human PNG checkpoint (below). The principled upgrade is to lift
> each animal's channel→pose mapping into a pure function (like Tier-1's
> pipeline) and measure real deltas; until then this is the deterministic,
> no-render proxy that's red today and climbs as Renders consume more.

## Running it

All commands from `apps/mobile`:

```sh
# Score everything; (re)writes out/*.json and prints the headline.
node src/avatars/expressivity/harness/iterate.mjs score

# Print the next iteration's subagent task (worst animal + dead cells + rules).
node src/avatars/expressivity/harness/iterate.mjs next

# After an edit: gate it. Fails on any regression OR any edit to a
# frozen metric file.
node src/avatars/expressivity/harness/iterate.mjs gate

# Full cycle until target or N iterations. With --exec, fully autonomous.
node src/avatars/expressivity/harness/iterate.mjs loop --max 8
node src/avatars/expressivity/harness/iterate.mjs loop --max 8 --exec "claude -p --dangerously-skip-permissions"
```

The plain test (`npx vitest run src/avatars/expressivity/expressivity.test.ts`)
self-tests the harness and writes the scorecards; CI runs it like any
other unit test.

## The loop, and why it's hard to game

```
score → snapshot + freeze-hash the metric files
  └─ target met?  ──yes──▶ done
        │no
        ▼
   next: worst (animal, dead-channel/region) → subagent task prompt
        ▼
   agent edits ONLY components.tsx / AvatarRenderer.tsx (the Renders)
        ▼
   gate: re-score; FAIL on any per-animal/Tier-1 regression
         or any change to a frozen file → loop back to score
```

Three guardrails make the number trustworthy:

1. **Frozen metric.** `harness/*`, `corpus/*`, and `expressivity.test.ts`
   are hashed; the gate fails if they change. The agent can't "pass" by
   editing the scorer or the corpus.
2. **Regression gate.** A fix that raises one animal but drops another
   (or drops Tier-1) is rejected.
3. **Human checkpoint.** Coverage can be satisfied by ugly motion. Render
   the representative poses on-device (the `AvatarCacheWarmer` path) and
   eyeball them every few rounds — your eye is the final judge of
   magnitude and taste, which Tier-2 deliberately doesn't score.

## The target

In `iterate.mjs` (`TARGET`): Tier-1 ≥ 0.85 (signal stays healthy),
Tier-2 ≥ 0.85, `eyesExpressiveFraction` ≥ 0.8 (close the eyes gap), and
no per-animal score < 0.6 (no flat outliers). Raising these is how you
ask for more expressivity.

## Corpus

`corpus/synth.ts` is a **synthetic bootstrap** — deterministic, crude,
enough to exercise the pipeline and build the loop. For a baseline that
truly "does justice to the user's emotional range," record real clips
and load them via `corpus/index.ts` (the `loadCorpus()` seam already
prefers real fixtures when present). Synthetic-corpus numbers validate
the *plumbing*, not the *aesthetics*.
