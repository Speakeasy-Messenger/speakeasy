import { font as brandFont } from './tokens.js';

/**
 * Legacy font aliases. Maps the old `fonts.inter*` keys onto the
 * canonical Bricolage Grotesque weights from `tokens.font`. Existing
 * screens compile unchanged but render in the new face.
 *
 * Mapping:
 *   inter300 → Bricolage Regular (Bricolage doesn't ship a Light weight
 *              that fits the 300 slot; the spec only ships 5 weights and
 *              the lightest is Regular. Old "Light" copy comes out a hair
 *              heavier — acceptable, the spec's whisper still reads.)
 *   inter400 → Regular
 *   inter500 → Medium
 *   inter600 → SemiBold
 *   inter700 → Bold
 *
 * Phase D deletes this file. New code uses `font.regular | medium |
 * semibold | bold | extrabold` from `tokens.ts` directly.
 */
export const fonts = {
  inter300: brandFont.regular,
  inter400: brandFont.regular,
  inter500: brandFont.medium,
  inter600: brandFont.semibold,
  inter700: brandFont.bold,
} as const;

/**
 * Legacy typed-text presets. Shapes preserved so callers (`text.heroBody`,
 * `text.subtitle`, etc.) still produce a text style. Sizes are pulled
 * forward from the new spec where the legacy slot has a clear analog;
 * the rest are tuned to feel like the original treatment but in
 * Bricolage.
 */
export const text = {
  heroBody: { fontFamily: fonts.inter500, fontSize: 22, letterSpacing: -0.3 },
  subtitle: { fontFamily: fonts.inter400, fontSize: 14, letterSpacing: -0.2 },
  sectionLabel: { fontFamily: fonts.inter500, fontSize: 10, letterSpacing: 2 },
  introLabel: { fontFamily: fonts.inter500, fontSize: 10, letterSpacing: 2 },
  // ID reveal — switched to Bold (the spec's wordmark uses 700 too).
  idWord: { fontFamily: fonts.inter700, fontSize: 38, letterSpacing: -0.4 },
  micro: { fontFamily: fonts.inter400, fontSize: 12, letterSpacing: 0 },
  footnote: { fontFamily: fonts.inter400, fontSize: 9, letterSpacing: 0 },
} as const;
