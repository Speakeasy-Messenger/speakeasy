# Mobile design debt

Output of a source-code design audit (2026-05-18). The app has a
well-designed theme token system at `src/theme/` (4px spacing scale,
named type scale, light/dark color tokens, motion tokens) — but it is
**badly under-adopted**. `tokens.ts` says "NOTHING should reach for a
hard-coded color literal"; the implementation drifted hard.

This is a backlog, not a plan-of-record. Each item is a scoped sweep;
do them as deliberate, separately-reviewed passes — not one mega-diff.

## Audit grades

| Dimension            | Grade | Headline problem |
| -------------------- | ----- | ---------------- |
| Accessibility        | F → C | 1 `accessibilityRole` app-wide; 40/42 interactive files had none |
| Typography           | D     | `theme/Text.tsx` typed components imported by zero files (dead); 23 `fontSize` values vs 8 in the scale |
| Component consistency| D     | `Bubble.tsx` + `AppBar.tsx` imported by nobody; header back-button fragment copy-pasted 10+ times |
| Motion               | D     | `motion` tokens used by 3 files; durations hardcoded elsewhere (incl. `750`, `900` — not tokens) |
| Spacing              | D+    | 128 off-scale magic numbers; `14` is a de-facto shadow token |
| Color                | C     | onboarding screens redeclare `BONE/BRASS` literals (7 files); `VideoCallScreen.tsx` has 10 raw color literals |
| Theme adherence      | C−    | color routing is decent on workspace screens — the saving grace |
| AI-slop              | B     | low — the brand work reads as intentional |

## Done (2026-05-18)

- ✅ **A11y on shared row primitives** — `ListItem` + `SettingsListItem`
  got `accessibilityRole="button"` + a text-derived `accessibilityLabel`;
  the settings `Switch` got a label. Accessibility F → ~C. (`4ddf235`)
- ✅ **Pass 1 — list primitives onto the type scale.** `ListItem` +
  `SettingsListItem` now render through the typed `Text*` components
  from `theme/Text.tsx` (previously 100% dead code). (`5496cf8`)
- ✅ **Pass 3 — de-hardcode brand-screen colors.** 7 onboarding/brand
  screens now source `BONE/BRASS/INK/TEXT_MUTE/TEXT_FAINT` from theme
  tokens; the `TEXT_FAINT` 0.18 drift corrected to 0.12. (`46f7bb6`)
- ✅ **Pass 2 — unified AppBar + row primitives.** Dead `Bubble.tsx`
  and dead `ListItem.tsx` deleted. `AppBar` rebuilt as a flexible slot
  component (`onBack` / `leading` / `title` / `subtitle` /
  `onTitlePress` / `trailing`, layout on the 4px scale). 18 screens
  migrated onto it: the 7 settings/workspace headers, the 8 remaining
  workspace screens (FullMessage, BlockList, Diagnostics,
  DeleteAccount, AvatarPicker, AvatarPreview, NewGroup, GroupSettings),
  and the 3 conversation headers (Chat, GroupChat, Conversations).
  `SettingsListItem` stands as the single row primitive. ShareHandle
  intentionally left alone (brand-canvas screen). Verified on the
  Android emulator (release build, before/after screenshots).
- 🟡 **Pass 4 (in progress) — motion + component spacing done.**
  `motion` gained `pulse` (750) and `ripple` (900); the slow/`dissolve`/
  `screen`-matching durations are routed through `motion.*`. All 14
  component files had their off-scale spacing snapped onto the 4px
  `space` scale from `tokens.ts` (round-up-to-scale rule: 2→4, 6→8,
  10→12, 14→16, 18→20, 22→24, 28→32; ties up). Files on the legacy
  `spacing.ts` scale switched to `tokens.ts` (value-preserving rename).
  **Remaining:** ~93 off-scale spacing literals across 23 screen files.

Passes 1 + 3 (and the Pass 4 motion routing) were exact-value token
swaps — rendered output unchanged. Pass 2 was verified on-device. The
Pass 4 spacing snaps shift pixels by 1–4px each and want emulator
verification.

## Remediation passes (open — need the emulator)

- **Pass 4 (finish) — screen spacing.** Snap the remaining ~93
  off-scale spacing literals across the 23 screen files onto the 4px
  `space` scale, same round-up rule. Census is done (line-by-line).

## Open (no device needed)

- **Finish a11y.** Icon-only buttons (call, attachment, camera, back
  arrows, FAB) still announce nothing — add `accessibilityRole` +
  `accessibilityLabel`. Mechanical, safe.
- **Typography — the screen tail.** Pass 1 did the list primitives;
  ~50 screens still hand-roll `fontFamily`+`fontSize`. Migrate them to
  the `Text*` components. Reconcile the `14` vs `type.body` (15)
  body-size question first.
- **`VideoCallScreen.tsx`** — 10 raw color literals (`#000`, `#FFF`,
  `#FFFFFFCC`, …). Needs new `scrim`/`overlay` tokens designed for a
  full-screen video surface, then routed.

## No DESIGN.md

The repo has no `DESIGN.md`. The `src/theme/tokens.ts` comments are the
de-facto design system; promoting them to a real `DESIGN.md` would give
future reviews a baseline to calibrate against.
