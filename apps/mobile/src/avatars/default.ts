import { ANIMAL_IDS } from './components.js';

/**
 * Stable default animal for a user with no explicit `selectedAvatarId`.
 * FNV-1a → uniform-distribution-into-12 — same input always picks the
 * same animal, so a peer who hasn't customized their avatar shows up
 * consistently across our screens AND across other users' devices.
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
  const index = (h >>> 0) % ANIMAL_IDS.length;
  return ANIMAL_IDS[index]!;
}
