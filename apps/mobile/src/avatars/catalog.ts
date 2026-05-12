/**
 * AVATARSTORE.md §3 + §5 — single source of truth for the avatar
 * catalog. The renderer (`AvatarRenderer`) consumes `signatureEffect`
 * to dispatch animation modules; the store UX consumes `tier` /
 * `skuId` / `displayPrice`.
 *
 * Hardcoded per spec §5 — small catalog, no server config endpoint,
 * app review provides the natural change gate. Add a new animal by
 * appending here AND adding the matching `AnimalDef` to
 * `components.tsx` AND the matching effect module under `effects/`.
 */

export type AvatarTier = 'free' | 'rare' | 'legendary';

export interface AvatarDescriptor {
  /** Stable id; same value the existing ANIMALS registry keys on. */
  id: string;
  /** Display name in the picker / acquire sheet. */
  name: string;
  tier: AvatarTier;
  /**
   * StoreKit / Play Billing product id. Required for `rare` and
   * `legendary`; undefined for `free`. Must match the configured
   * SKU exactly per §4.
   */
  skuId?: string;
  /**
   * UI hint only — actual price comes from the platform store at
   * runtime. This is the cold-start fallback when the store SDK
   * hasn't returned product info yet.
   */
  displayPrice?: string;
  /**
   * Present only for `legendary` per §1. The fourth color the
   * three-color discipline relaxes for; one of jade / vermillion /
   * lapis / oxblood per `speakeasy-legendaries.html`.
   */
  signatureColor?: string;
  /**
   * String identifier dispatched by the renderer to the matching
   * effect module under `src/avatars/effects/<id>.ts`. Required
   * for `rare` and `legendary`.
   */
  signatureEffect?: string;
}

/**
 * 28 entries: 12 free + 12 rare + 4 legendary. Order matters — the
 * picker renders sections in this same order ("Yours" computed from
 * ownership state).
 */
export const CATALOG: readonly AvatarDescriptor[] = [
  // ── Free (12) ────────────────────────────────────────────────
  { id: 'fox', name: 'Fox', tier: 'free' },
  { id: 'owl', name: 'Owl', tier: 'free' },
  // Spec §5 lists "raven" under both Free and Rare. Resolution: free
  // common bird is `pigeon`; the rare illustrated raven (head_tilt
  // signature effect) takes the `raven` id. Migration in profiles
  // store maps any pre-rc.6 'raven' selection back to 'pigeon'.
  { id: 'pigeon', name: 'Pigeon', tier: 'free' },
  { id: 'hare', name: 'Hare', tier: 'free' },
  { id: 'stag', name: 'Stag', tier: 'free' },
  { id: 'whale', name: 'Whale', tier: 'free' },
  { id: 'moth', name: 'Moth', tier: 'free' },
  { id: 'octopus', name: 'Octopus', tier: 'free' },
  { id: 'heron', name: 'Heron', tier: 'free' },
  { id: 'bear', name: 'Bear', tier: 'free' },
  { id: 'cat', name: 'Cat', tier: 'free' },
  { id: 'bat', name: 'Bat', tier: 'free' },

  // ── Rare (12) — see §10 for per-animal specs ────────────────
  { id: 'lynx', name: 'Lynx', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.lynx', displayPrice: '$9.99', signatureEffect: 'ear_tuft_twitch' },
  { id: 'koi', name: 'Koi', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.koi', displayPrice: '$9.99', signatureEffect: 'fin_ripple' },
  { id: 'raven', name: 'Raven', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.raven', displayPrice: '$9.99', signatureEffect: 'head_tilt' },
  { id: 'frog', name: 'Frog', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.frog', displayPrice: '$9.99', signatureEffect: 'throat_sac' },
  { id: 'snake', name: 'Snake', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.snake', displayPrice: '$9.99', signatureEffect: 'tongue_flick' },
  { id: 'peacock', name: 'Peacock', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.peacock', displayPrice: '$9.99', signatureEffect: 'eyespot_pulse' },
  { id: 'hawk', name: 'Hawk', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.hawk', displayPrice: '$9.99', signatureEffect: 'staccato_turn' },
  { id: 'squirrel', name: 'Squirrel', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.squirrel', displayPrice: '$9.99', signatureEffect: 'tail_sweep' },
  { id: 'crab', name: 'Crab', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.crab', displayPrice: '$9.99', signatureEffect: 'claw_snap' },
  { id: 'beetle', name: 'Beetle', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.beetle', displayPrice: '$9.99', signatureEffect: 'shell_split' },
  { id: 'anglerfish', name: 'Anglerfish', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.anglerfish', displayPrice: '$9.99', signatureEffect: 'lure_pulse' },
  { id: 'seahorse', name: 'Seahorse', tier: 'rare', skuId: 'com.speakeasy.avatar.rare.seahorse', displayPrice: '$9.99', signatureEffect: 'dorsal_ripple' },

  // ── Legendary (4) ───────────────────────────────────────────
  { id: 'dragon', name: 'Dragon', tier: 'legendary', skuId: 'com.speakeasy.avatar.legendary.dragon', displayPrice: '$99.99', signatureColor: '#3D9D6F', signatureEffect: 'dragon_full' },
  { id: 'phoenix', name: 'Phoenix', tier: 'legendary', skuId: 'com.speakeasy.avatar.legendary.phoenix', displayPrice: '$99.99', signatureColor: '#C8413A', signatureEffect: 'phoenix_full' },
  { id: 'turtle', name: 'Turtle', tier: 'legendary', skuId: 'com.speakeasy.avatar.legendary.turtle', displayPrice: '$99.99', signatureColor: '#1F7B8A', signatureEffect: 'turtle_full' },
  { id: 'manticore', name: 'Manticore', tier: 'legendary', skuId: 'com.speakeasy.avatar.legendary.manticore', displayPrice: '$99.99', signatureColor: '#7E2D40', signatureEffect: 'manticore_full' },
];

/** Index by id for O(1) lookups. */
const BY_ID = new Map<string, AvatarDescriptor>(
  CATALOG.map((entry) => [entry.id, entry] as const),
);

export function descriptorFor(id: string): AvatarDescriptor | undefined {
  return BY_ID.get(id);
}

/** All rare entries (12). */
export const RARES: readonly AvatarDescriptor[] = CATALOG.filter(
  (e) => e.tier === 'rare',
);

/** All legendary entries (4). */
export const LEGENDARIES: readonly AvatarDescriptor[] = CATALOG.filter(
  (e) => e.tier === 'legendary',
);

/** Free entries (12). Always owned. */
export const FREE_AVATARS: readonly AvatarDescriptor[] = CATALOG.filter(
  (e) => e.tier === 'free',
);
