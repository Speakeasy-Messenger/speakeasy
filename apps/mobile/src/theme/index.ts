export { colors } from './colors.js';
export { fonts, text } from './typography.js';
export { space, radius } from './spacing.js';

import { accent } from './tokens.js';
import { useTheme } from './ThemeProvider.js';

/**
 * Hook flavour of the legacy `colors` alias — same shape, but the
 * values come from the active theme (system/dark/light). Use this
 * inside components that should respond to mode changes; the static
 * `colors` import stays pinned to dark and is fine for module-level
 * `StyleSheet.create` calls.
 *
 * Migration plan: screens replace `import { colors }` with
 * `const colors = useColors()` inside the component body. Module-
 * level styles continue to consume the static alias for now — phase E
 * (full light-mode parity) finishes the job.
 */
export function useColors() {
  const t = useTheme();
  return {
    ink: t.text,
    cream: t.canvas,
    primary: t.accent,
    soft: t.surfacePressed,
    pale: t.surface,
    slate: t.textMute,
    chatListBg: t.canvas,
    receivedBubble: t.surface,
    sentBubble: accent.base,
    divider: t.textFaint,
  };
}
