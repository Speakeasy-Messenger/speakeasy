import { api } from '../services.js';
import { useIdentity } from './identity.js';
import { useProfiles } from './profiles.js';

/**
 * Fetch a peer's current profile (selected avatar) into the cache.
 *
 * `force` bypasses the freshness TTL — used at moments where a stale
 * avatar is most visible and worth a guaranteed round-trip (opening a
 * call screen). Without it a peer who changed their avatar would show
 * their old one until the TTL expired (the rc.56 "bananaman6 switched
 * heron→fox and it didn't change" report). Best-effort + silent: the
 * deterministic `defaultAnimalForUser` fallback covers any failure.
 */
export async function refreshProfile(userId: string, force = false): Promise<void> {
  if (!force && useProfiles.getState().isFresh(userId)) return;
  const deviceToken = useIdentity.getState().deviceToken;
  if (!deviceToken) return;
  try {
    const u = await api.fetchUser(deviceToken, userId);
    useProfiles.getState().set(userId, {
      selectedAvatarId: u.selected_avatar_id ?? undefined,
      fetchedAt: Date.now(),
    });
  } catch {
    /* silent — fallback avatar covers it */
  }
}
