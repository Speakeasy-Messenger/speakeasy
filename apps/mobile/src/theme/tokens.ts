/**
 * Canonical brand tokens. See `BRANDING1.md` for the full spec.
 *
 * Speakeasy operates two color systems:
 *
 *  - **Brand palette** (mode-invariant aubergine) — used on stage
 *    moments: splash, onboarding, IdReveal, brand hero screens.
 *  - **Workspace palette** (light + dark) — used everywhere the user
 *    is *doing*: conversation list, chat, settings, etc.
 *
 * Both share the **brass accent**, which is mode-invariant. Outgoing
 * bubbles and primary CTAs use brass + ink in both modes — the user's
 * own messages keep identical brand presence regardless of theme.
 *
 * NOTHING in the app should reach for a hard-coded color literal.
 * Components consume `useTheme()` (from `./ThemeProvider`) for
 * workspace tokens; brand-canvas screens reach for `theme.brand.*`
 * directly.
 */

// Mode-invariant brand palette — used on stage screens.
export const brand = {
  canvas: '#14091A',
  surface: '#1F1126',
  surfacePressed: '#2A1932',
} as const;

// Mode-invariant accent — same in brand, dark, and light contexts.
export const accent = {
  base: '#E5A645',
  pressed: '#C48A33',
  /** Text/icon color on top of accent surfaces. Mode-invariant — the
   * user's own messages always read the same. */
  foreground: '#14091A',
} as const;

/**
 * Mode-invariant scrim tints. The brand's per-mode `textGhost` /
 * `textFaint` aren't right for these surfaces because they invert
 * with the mode (transparent over the canvas), but a scrim wants to
 * dim *whatever's behind it* regardless of mode — picture overlays,
 * loading-state placeholders, modal backdrops. So: pure black at
 * graduated alpha, used sparingly.
 */
export const scrim = {
  /** Subtle (≈6%) — image cell while a base64 → bitmap decode is
   * pending. Just enough to read as "loading" against any bubble. */
  subtle: '#00000010',
  /** Heavy (≈38%) — modal backdrop / picker-while-resolving overlay. */
  modal: '#00000060',
} as const;

/**
 * Call-control palette — *intentional* divergence from the brand's
 * "no third color" rule (BRANDING1.md §1). Phone-call UX is the one
 * surface where red-decline / green-accept is so deeply learned across
 * iOS + Android that going brand-pure (e.g. accent + secondary)
 * actively confuses users mid-call. Centralized here so the
 * divergence is visible in one place rather than sprinkled across
 * IncomingCallScreen / CallScreen / CallsScreen / DialerScreen as
 * stray hex literals.
 *
 * Foreground (`fg`) is cream — both reds + greens at this saturation
 * are dim enough that ink-on-color is illegible.
 */
export const callPalette = {
  decline: '#D63E3E',
  accept: '#1FA463',
  fg: '#F2E9D8',
} as const;

// Per-mode workspace tokens — resolved via ThemeProvider.
export const workspace = {
  dark: {
    canvas: '#0F0E12',
    surface: '#17161B',
    surfacePressed: '#201E25',
    text: '#F2E9D8',
    textMute: 'rgba(242,233,216,0.55)',
    textFaint: 'rgba(242,233,216,0.12)',
    textGhost: 'rgba(242,233,216,0.06)',
  },
  light: {
    canvas: '#F7EFDD',
    surface: '#EDE2CB',
    surfacePressed: '#E2D6B9',
    text: '#14091A',
    textMute: 'rgba(20,9,26,0.6)',
    textFaint: 'rgba(20,9,26,0.15)',
    textGhost: 'rgba(20,9,26,0.08)',
  },
} as const;

/**
 * Bricolage Grotesque, 5 static weights. Bundled at
 * `apps/mobile/android/app/src/main/assets/fonts/`. iOS bundle pending.
 *
 * The string values must match the on-disk filename minus extension —
 * RN's font lookup uses that as the family identifier on Android.
 */
export const font = {
  regular: 'BricolageGrotesque-Regular',
  medium: 'BricolageGrotesque-Medium',
  semibold: 'BricolageGrotesque-SemiBold',
  bold: 'BricolageGrotesque-Bold',
  extrabold: 'BricolageGrotesque-ExtraBold',
} as const;

/**
 * Type scale per BRANDING1.md §2.2. Sizes are points; weight is the
 * Bricolage variant; letterSpacing is in em (RN takes a number that
 * multiplies font size — we resolve to absolute px in the helper).
 */
export const type = {
  // 64 fits "speakeasy" on a typical 360-logical-px phone with
  // workspace padding intact. Larger screens still get the spec's
  // range (56–96) — the wordmark uses `adjustsFontSizeToFit` as a
  // safety net for narrower devices.
  display: { size: 64, weight: font.bold, letterSpacingEm: -0.045 },
  title: { size: 22, weight: font.semibold, letterSpacingEm: -0.02 },
  subtitle: { size: 17, weight: font.medium, letterSpacingEm: -0.01 },
  body: { size: 15, weight: font.regular, letterSpacingEm: 0 },
  bodyEmphasis: { size: 15, weight: font.medium, letterSpacingEm: 0 },
  caption: { size: 12, weight: font.regular, letterSpacingEm: 0 },
  /** Section labels, statuses ("E2E", "OFFLINE"). Uppercase + 0.20em tracking. */
  meta: { size: 10, weight: font.medium, letterSpacingEm: 0.2, uppercase: true },
  handle: { size: 13, weight: font.medium, letterSpacingEm: 0 },
} as const;

// 4px base — don't invent in-between values.
export const space = {
  xs: 4,
  s: 8,
  m: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  mega: 64,
} as const;

/**
 * Sharp by default. The brand is geometric. Phone-frame radius `frame`
 * is reserved for marketing demos (28px). UI elements stay at 0–4.
 *
 * Avatars are 4px squares per the rebrand decision (was circles); they
 * use `sm`.
 */
export const radius = { none: 0, xs: 2, sm: 4, frame: 28 } as const;

/**
 * ms durations. Linear ease-out unless otherwise noted.
 *
 * `pulse` / `ripple` are the slow brand moments on CallScreen — the
 * connecting-state breathing pulse of the Door mark, and the speech
 * ring that expands off the peer portrait while they talk. They sit
 * past `dissolve` on purpose: slow enough to read as ambient
 * atmosphere rather than as a UI transition.
 */
export const motion = {
  tap: 100,
  fade: 150,
  screen: 240,
  dissolve: 600,
  pulse: 750,
  ripple: 900,
} as const;

export type Mode = 'dark' | 'light';

/**
 * Both palettes (`workspace.dark`, `workspace.light`) are typed by
 * `as const` to literal hex strings, which TS would treat as
 * incompatible across modes. Widen each field to `string` for the
 * shared shape — the hex values themselves stay precise at the
 * `workspace.*` use site.
 */
export interface WorkspaceTokens {
  canvas: string;
  surface: string;
  surfacePressed: string;
  text: string;
  textMute: string;
  textFaint: string;
  textGhost: string;
}
