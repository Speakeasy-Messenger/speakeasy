/**
 * Legacy spacing + radius tokens. The brand spec is sharp by default
 * (§2.4): no pill buttons, no fully rounded avatars. Existing screens
 * import these names; values here are remapped to spec-compliant
 * geometry (radius 0 / 4) while preserving the spacing semantics.
 *
 * Phase D deletes this file once consumers migrate to `space` and
 * `radius` from `tokens.ts`.
 */
export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  // Was 10. Spec calls for 4 — a "subtle softening on small elements"
  // (§2.4 radius-2). Avatars are now 4px-radius squares per the
  // rebrand decision.
  avatar: 4,
  // Was 999 (pill). Spec forbids pill buttons (§2.4); buttons are
  // sharp at 0. Inputs and tags get a `subtle` 4 (§6.4).
  pill: 4,
  // Bubbles: 4 sharp (§6.2/6.3). The 16-radius rounded bubble is gone.
  bubble: 4,
  bubbleTail: 0,
  // Brand marks render at fixed pixel sizes — the icon-mark inner
  // radius is no longer applied (Cipher S has no inner radius).
  iconMark: 0,
  // App-icon shell: spec doesn't softpath the launcher icon — the OS
  // applies its own mask. Keep small for any internal preview.
  appIcon: 4,
} as const;
