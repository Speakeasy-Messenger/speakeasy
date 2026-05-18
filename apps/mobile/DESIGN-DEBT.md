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

- ✅ **A11y on shared row primitives** — `ListItem.tsx` and
  `SettingsListItem.tsx` got `accessibilityRole="button"` + a
  text-derived `accessibilityLabel`; the settings `Switch` got an
  `accessibilityLabel`. Commit `4ddf235`. This labelled the majority of
  the app's tappable rows. Accessibility F → ~C.

## Remediation passes (open)

1. **A11y — finish the job.** Icon-only buttons (call, attachment,
   camera, back arrows, FAB) and the 10+ hand-rolled per-screen headers
   still announce nothing. Add `accessibilityRole`/`accessibilityLabel`.
2. **Typography — adopt or delete `theme/Text.tsx`.** It is 100% dead
   code while 52 files hand-roll `fontFamily`+`fontSize`. Migrate the
   shared primitives first (`ListItem`, `SettingsListItem`, `Bubble`),
   which pulls most screens onto the scale for free. Reconcile the
   `14` vs `type.body.size` (15) body-size question.
3. **Spacing — sweep the 128 magic numbers** onto the 4px `space`
   scale. Worst files: `GroupSettingsScreen.tsx`, `Bubble.tsx`,
   `ChatScreen.tsx`. The recurring `14` should map to `space.m`/`base`.
4. **Color — de-hardcode the brand screens.** `FaceStep`, `HandleStep`,
   `RoomStep`, `PermissionsStep`, `IdRevealScreen`, `ShareHandleScreen`,
   `AcquireSheet` redeclare `BONE/BRASS/TEXT_MUTE` as literals — route
   through `theme.brand`/`theme.accent`. `VideoCallScreen.tsx` needs
   `scrim`/`overlay` tokens for its 10 raw literals. Fix the
   `TEXT_FAINT` `0.18`-vs-`0.12`-token drift.
5. **Component consistency — resolve the dead primitives.** `Bubble.tsx`
   and `AppBar.tsx` are imported by nobody; `Button.tsx` only by
   onboarding. Either delete them, or (better) make `AppBar` flexible
   enough to replace the 10+ copy-pasted header fragments and migrate.
   Collapse `ListItem` + `SettingsListItem` (two row primitives, same
   concept, different heights/paddings/type sizes) into one.
6. **Motion — route durations through `motion.*`** tokens; add the
   missing slow durations (`750`, `900`) as named tokens.

## No DESIGN.md

The repo has no `DESIGN.md`. The `src/theme/tokens.ts` comments are the
de-facto design system; promoting them to a real `DESIGN.md` would give
future reviews a baseline to calibrate against.
