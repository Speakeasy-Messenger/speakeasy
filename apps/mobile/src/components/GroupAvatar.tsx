import React, { useEffect } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { api } from '../services.js';
import { colors, fonts } from '../theme/index.js';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Round avatar for a group. Mirrors `<Avatar>` but reads the bytes
 * out of the groups store (not profiles), and uses `#` as the
 * initials fallback. Lazy-fetches `GET /v1/groups/:id` once per 24h
 * and writes the avatar/createdBy back through `useGroups.upsert`.
 */
interface Props {
  groupId: string;
  /** Display name — used as the initials fallback (first char). */
  name?: string;
  size?: number;
  style?: import('react-native').StyleProp<import('react-native').ViewStyle>;
}

export function GroupAvatar({ groupId, name, size = 36, style }: Props) {
  const group = useGroups((s) => s.byId[groupId]);
  const upsert = useGroups((s) => s.upsert);

  useEffect(() => {
    const fetchedAt = group?.metadataFetchedAt ?? 0;
    if (Date.now() - fetchedAt < TTL_MS) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) return;
    let cancelled = false;
    void api
      .fetchGroup(deviceToken, groupId)
      .then((g) => {
        if (cancelled) return;
        upsert({
          id: groupId,
          // Preserve name/members/createdAt; upsert merges these.
          name: group?.name ?? '',
          members: group?.members ?? [],
          createdAt: group?.createdAt ?? Date.now(),
          createdBy: g.created_by,
          avatarB64: g.avatar_b64 ?? undefined,
          metadataFetchedAt: Date.now(),
        });
      })
      .catch(() => {
        // Silent — the `#` fallback covers the no-data case.
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, group?.metadataFetchedAt, group?.name, group?.members, group?.createdAt, upsert]);

  // Spec §10: no avatar circles. Group thumbnails are 4-radius
  // squares — same as user avatars.
  const wrapperStyle = [
    styles.wrap,
    { width: size, height: size, borderRadius: 4 },
    style,
  ];
  const fallback = name?.slice(0, 1).toUpperCase() || '#';

  if (group?.avatarB64) {
    return (
      <View style={wrapperStyle}>
        <Image
          source={{ uri: `data:image/jpeg;base64,${group.avatarB64}` }}
          style={[styles.image, { width: size, height: size, borderRadius: 4 }]}
        />
      </View>
    );
  }
  return (
    <View style={wrapperStyle}>
      <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>
        {fallback}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: { resizeMode: 'cover' },
  initial: {
    fontFamily: fonts.inter500,
    color: colors.cream,
  },
});
