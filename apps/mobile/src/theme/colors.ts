import { accent, workspace } from './tokens.js';

/**
 * Legacy palette aliases. The rebrand canonical palette lives in
 * `tokens.ts` and is consumed via `useTheme()`; this file remains so
 * existing screens (which import `colors.primary` etc.) globally
 * upgrade to the new aubergine + brass + bone scheme without
 * per-screen edits.
 *
 * Values are pinned to the **dark workspace** mode — that's the spec
 * default. Light-mode consumers must migrate to `useTheme()` directly
 * (phase D / future work).
 *
 * Phase D will delete this file once every consumer has been moved to
 * `useTheme()` / direct `tokens.*` imports.
 */
export const colors = {
  // Foreground — was a near-black ink. Now the warm bone foreground
  // that sits on top of the dark workspace canvas.
  ink: workspace.dark.text,
  // Primary background — was cream. Now the dark workspace canvas.
  // Old screens that used `colors.cream` as a "page bg" pick this up
  // automatically.
  cream: workspace.dark.canvas,
  // Brand voice — was purple. Now brass.
  primary: accent.base,
  // Soft / surface variant — was a purple-tinted pale. Now the
  // pressed-state surface (the most-tinted of the three workspace
  // surfaces).
  soft: workspace.dark.surfacePressed,
  // Pale surface — was a purple-tinted background. Now the standard
  // raised surface (bubbles/cards).
  pale: workspace.dark.surface,
  // Metadata text — was slate gray. Now the muted workspace foreground
  // (~55% opacity bone).
  slate: workspace.dark.textMute,

  // Convenience aliases referenced by chat surfaces. Spec §6.2/6.3:
  // incoming bubble = `surface`; outgoing = brass.
  chatListBg: workspace.dark.canvas,
  receivedBubble: workspace.dark.surface,
  sentBubble: accent.base,
  divider: workspace.dark.textFaint,
} as const;

export type ColorToken = keyof typeof colors;
