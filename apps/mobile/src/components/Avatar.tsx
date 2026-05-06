import React, { useEffect } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { api } from '../services.js';
import { colors, fonts } from '../theme/index.js';

/**
 * Round avatar with a base64-JPEG image when set, falling back to the
 * first letter of the userId on a soft pale background. Lazy-fetches
 * the peer's avatar from `GET /v1/users/:id` and caches it in the
 * profiles store; the cached entry has a 24h TTL so a peer changing
 * their avatar shows up on the other side within a day (or on
 * conversation open after the cache expires).
 */
interface Props {
  userId: string;
  /** Pixel size of the avatar circle. Default 36 (matches list rows). */
  size?: number;
  /** Override the fallback initial source — defaults to the userId's
   * first character. Useful for groups (callers pass the group name). */
  initialOf?: string;
  /** Optional style override on the outer wrapper. */
  style?: import('react-native').StyleProp<import('react-native').ViewStyle>;
}

export function Avatar({ userId, size = 36, initialOf, style }: Props) {
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
          avatarB64: u.avatar_b64 ?? undefined,
          fetchedAt: Date.now(),
        });
      })
      .catch(() => {
        // Silent — the initials fallback covers the no-avatar case
        // and a transient network error shouldn't break list rendering.
      });
    return () => {
      cancelled = true;
    };
    // We intentionally re-run on a userId change but not on every
    // render — `isFresh` reads through Zustand and skips on its own.
  }, [userId, isFresh, setProfile]);

  // Spec §10: no avatar circles. Avatars are 4-radius squares —
  // small enough to read as "thumbnail" without echoing the
  // forbidden circular-badge motif. Same `radius.sm` used by chat
  // bubbles and inputs.
  const wrapperStyle = [
    styles.wrap,
    { width: size, height: size, borderRadius: 4 },
    style,
  ];
  const initial = (initialOf ?? userId).slice(0, 1).toUpperCase();

  if (profile?.avatarB64) {
    return (
      <View style={wrapperStyle}>
        <Image
          source={{ uri: `data:image/jpeg;base64,${profile.avatarB64}` }}
          style={[styles.image, { width: size, height: size, borderRadius: 4 }]}
        />
      </View>
    );
  }
  return (
    <View style={wrapperStyle}>
      <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.pale,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: { resizeMode: 'cover' },
  initial: {
    fontFamily: fonts.inter500,
    color: colors.primary,
  },
});
