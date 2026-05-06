import React from 'react';
import { CipherS } from '../brand/CipherS.js';
import { accent } from '../theme/tokens.js';

export interface IconMarkProps {
  /** Outer size in px. Default 64. */
  size?: number;
  /**
   * Reserved for back-compat. The pre-rebrand mark animated; the new
   * Cipher S is a flat geometric primitive that doesn't.
   */
  animate?: boolean;
  /** Override the brass fill. Rare — the spec says brass is canonical. */
  color?: string;
  /** Reserved for back-compat. The new mark has no shell — flat fill only. */
  shell?: boolean;
}

/**
 * Backwards-compat shim over the new {@link CipherS} primary mark.
 * The brand spec's canonical app icon is Cipher S in brass on a
 * brand-canvas (aubergine) tile — the Onboarding / IdReveal screens
 * render the canvas separately and just drop this in.
 *
 * Existing screens still import `IconMark`; new code should reach
 * for `CipherS` / `Door` / `Peephole` directly from `src/brand/`.
 */
export function IconMark({ size = 64, color = accent.base }: IconMarkProps): React.JSX.Element {
  return <CipherS size={size} color={color} />;
}
