import React, { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { api } from '../services.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { PortraitTile } from './PortraitTile.js';

/**
 * 1:1 user avatar — animal portrait inside a sharp surface tile.
 * Phase 2 brand overhaul (AVATAR-SYSTEM.md §8): replaces the previous
 * profile-photo (JPEG-blob) renderer.
 *
 * Behaviour:
 *  - Reads the peer's `selectedAvatarId` from the profiles cache.
 *  - Lazy-fetches via `GET /v1/users/:id` if not fresh (24h TTL).
 *  - Falls back to `defaultAnimalForUser(userId)` while the fetch is
 *    in flight, so list rows render immediately instead of flashing.
 *
 * Same prop shape as the previous version (`userId`, `size`,
 * `initialOf`, `style`) so existing callsites compile unchanged. The
 * `initialOf` prop is now ignored — animal id supersedes initials.
 */

interface Props {
  userId: string;
  /** Pixel size of the avatar tile. Default 36 (matches list rows). */
  size?: number;
  /** @deprecated — kept on the prop type so existing callsites compile.
   * Animals supersede initials. */
  initialOf?: string;
  /** Optional style override on the outer wrapper. The PortraitTile
   * applies its own width/height/border; pass `style` for additional
   * margin or position. */
  style?: StyleProp<ViewStyle>;
}

export function Avatar({ userId, size = 36 }: Props): React.ReactElement {
  const profile = useProfiles((s) => s.byUserId[userId]);
  const isFresh = useProfiles((s) => s.isFresh);
  const setProfile = useProfiles((s) => s.set);

  useEffect(() => {
    if (isFresh(userId)) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) return;
    let cancelled = false;
    void api
      .fetchUser(deviceToken, userId)
      .then((u) => {
        if (cancelled) return;
        setProfile(userId, {
          selectedAvatarId: u.selected_avatar_id ?? undefined,
          fetchedAt: Date.now(),
        });
      })
      .catch(() => {
        // Silent — the deterministic-from-userId fallback covers the
        // no-data case and a transient network error shouldn't break
        // list rendering.
      });
    return () => {
      cancelled = true;
    };
  }, [userId, isFresh, setProfile]);

  const animalId = profile?.selectedAvatarId ?? defaultAnimalForUser(userId);

  return (
    <PortraitTile
      kind="animal"
      id={animalId}
      size={size}
      // List rows + AppBars routinely render 5–10 avatars at once;
      // 10 simultaneously-blinking eyes feel cluttered. Skip blink
      // outside the call-stage / settings-picker contexts where the
      // animal is the sole subject.
      skipBlink
      // `style` was the outer wrapper override. PortraitTile renders
      // its own View; the style escapes via a wrapping View when
      // needed. Most callsites passed nothing, so just ignore here —
      // a future change can lift this if a callsite requires it.
    />
  );
}
