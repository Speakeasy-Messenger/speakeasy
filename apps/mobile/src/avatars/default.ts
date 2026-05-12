import { FREE_AVATARS } from './catalog.js';

/**
 * Stable default animal for a user with no explicit `selectedAvatarId`.
 * FNV-1a → uniform-distribution-into-12 — same input always picks the
 * same animal, so a peer who hasn't customized their avatar shows up
 * consistently across our screens AND across other users' devices.
 *
 * **Important:** sources from the *free* 12 animals only. Paid avatars
 * are now in ANIMALS too (the renderer dispatches on the full set);
 * defaulting a user to a paid animal they haven't acquired would be a
 * privacy + presentation bug — peers would render them with an avatar
 * the owner doesn't actually own.
 *
 * Used:
 *   - On first enrollment, before the user has reached onboarding's
 *     "Choose your face" screen (Phase 3 work).
 *   - As a fallback for any peer whose profile hasn't synced yet.
 *   - Tier B / integration tests where we don't want to populate
 *     selectedAvatarId by hand for every test fixture.
 */
export function defaultAnimalForUser(userId: string): string {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const index = (h >>> 0) % FREE_AVATARS.length;
  return FREE_AVATARS[index]!.id;
}
