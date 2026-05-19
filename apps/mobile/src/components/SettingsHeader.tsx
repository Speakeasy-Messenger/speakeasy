import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Handle } from './Handle.js';
import { PortraitTile } from './PortraitTile.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';

/**
 * SETTINGS.md §3.2 / §7.1 — reusable header.
 *
 * 64×64 portrait + display-style handle + meta-style sub. The
 * landing variant shows `CONNECTED` / `OFFLINE`; the Account
 * variant shows `SINCE MARCH 2026` (the user's account creation
 * date). Tap the whole block to open Account from the landing
 * surface; on Account itself it's non-interactive.
 */

interface Props {
  /** Sub-line text — caller controls so the same component serves
   * landing (CONNECTED / OFFLINE) and Account (SINCE MARCH 2026). */
  metaSub: string;
  /** Tap handler — only set on the landing variant. */
  onPress?: () => void;
  testID?: string;
}

export function SettingsHeader({
  metaSub,
  onPress,
  testID,
}: Props): React.ReactElement {
  const themed = useColors();
  const userId = useIdentity((s) => s.userId);
  const profile = useProfiles((s) =>
    userId ? s.byUserId[userId] : undefined,
  );
  const animalId = userId
    ? profile?.selectedAvatarId ?? defaultAnimalForUser(userId)
    : 'fox';

  const inner = (
    <View style={[styles.wrap, { borderBottomColor: themed.divider }]}>
      {userId ? (
        <PortraitTile kind="animal" id={animalId} size={64} />
      ) : (
        <View
          style={[
            styles.placeholder,
            { backgroundColor: themed.pale, borderColor: themed.divider },
          ]}
        />
      )}
      {userId ? (
        <View style={styles.handleWrap}>
          <Handle value={userId} variant="display" />
        </View>
      ) : (
        <Text style={[styles.dash, { color: themed.slate }]}>—</Text>
      )}
      <Text style={[styles.meta, { color: themed.slate }]}>{metaSub}</Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        testID={testID}
        style={({ pressed }) =>
          pressed ? { backgroundColor: themed.soft } : null
        }
      >
        {inner}
      </Pressable>
    );
  }
  return <View testID={testID}>{inner}</View>;
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingTop: space.xxl,
    paddingBottom: space.xl,
    paddingHorizontal: space.base,
    gap: space.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  placeholder: {
    width: 64,
    height: 64,
    borderWidth: StyleSheet.hairlineWidth,
  },
  handleWrap: { marginTop: 0 },
  dash: { fontFamily: font.bold, fontSize: 22 },
  meta: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9.5,
    letterSpacing: 0.22 * 9.5,
    textTransform: 'uppercase',
  },
});
