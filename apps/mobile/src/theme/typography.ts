/**
 * Speakeasy typography — spec §14 (April 2026 revision: Inter only).
 *
 * Suisse Int'l (paid) was the early sketch, Syne was the previous display
 * face. Both are out — Inter at 600/700 covers the display role.
 *
 * Letter spacing: -0.2px / -0.4px for body, 1.5-2px for caps labels.
 *
 * Font files must be added to ios/Resources and android/app/src/main/assets/fonts
 * after RN init (see apps/mobile/README.md). React Native uses PostScript
 * names on iOS and the filename without extension on Android — keep them
 * aligned.
 */
export const fonts = {
  inter300: 'Inter-Light',
  inter400: 'Inter-Regular',
  inter500: 'Inter-Medium',
  inter600: 'Inter-SemiBold',
  inter700: 'Inter-Bold',
} as const;

export const text = {
  /** Hero copy — "You're in." style headlines */
  heroBody: { fontFamily: fonts.inter500, fontSize: 22, letterSpacing: -0.3 },
  /** 14px subtitle in slate */
  subtitle: { fontFamily: fonts.inter300, fontSize: 14, letterSpacing: -0.2 },
  /** Section labels, all caps, 9px / 2px tracking */
  sectionLabel: { fontFamily: fonts.inter400, fontSize: 9, letterSpacing: 2 },
  /** Primary-purple "INTRODUCING" label on ID reveal — 9px / 2px tracking */
  introLabel: { fontFamily: fonts.inter500, fontSize: 9, letterSpacing: 2 },
  /** ID reveal words — Inter 700 38px (was Syne 700 pre-April-2026) */
  idWord: { fontFamily: fonts.inter700, fontSize: 38, letterSpacing: -0.4 },
  /** Inter 12px footer / aside */
  micro: { fontFamily: fonts.inter300, fontSize: 12, letterSpacing: 0 },
  /** Disappearing-message footnote, 9px slate */
  footnote: { fontFamily: fonts.inter400, fontSize: 9, letterSpacing: 0 },
} as const;
