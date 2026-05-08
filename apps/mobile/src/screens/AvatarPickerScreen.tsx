import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ANIMAL_IDS, ANIMALS } from '../avatars/components.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { api } from '../services.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
}

/**
 * SETTINGS.md §7 + AVATAR-SYSTEM.md §6.2 — avatar picker drilldown
 * from Account → "Change my face". Same 12-tile grid + scale-to-1.1
 * indication-of-selection treatment as the onboarding FaceStep
 * picker. Optimistic local write rolls back on server failure.
 */
export function AvatarPickerScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const userId = useIdentity((s) => s.userId);
  const ownProfile = useProfiles((s) =>
    userId ? s.byUserId[userId] : undefined,
  );
  const setProfile = useProfiles((s) => s.set);
  const selected = ownProfile?.selectedAvatarId;
  const [busy, setBusy] = useState(false);

  async function handlePick(animalId: string) {
    if (!userId || busy) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) {
      Alert.alert('Sign in again — device token missing.');
      return;
    }
    setBusy(true);
    const previous = selected;
    setProfile(userId, { selectedAvatarId: animalId, fetchedAt: Date.now() });
    try {
      await api.setAvatar(deviceToken, animalId);
      onBack();
    } catch (err) {
      setProfile(userId, { selectedAvatarId: previous, fetchedAt: Date.now() });
      Alert.alert('Could not save face', String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="avatar-picker-screen"
    >
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Change my face</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.helper, { color: themed.slate }]}>
          Pick a different animal. Anyone you've already shared your handle
          with sees the new face on their next refresh.
        </Text>
        <View style={styles.grid}>
          {ANIMAL_IDS.map((id) => {
            const active = id === selected;
            return (
              <Pressable
                key={id}
                onPress={() => void handlePick(id)}
                hitSlop={2}
                disabled={busy}
                style={[
                  styles.cell,
                  {
                    backgroundColor: themed.pale,
                    borderColor: active ? themed.primary : themed.divider,
                  },
                ]}
                testID={`avatar-pick-${id}`}
              >
                <View style={{ transform: [{ scale: active ? 1.1 : 1.0 }] }}>
                  <PortraitTile kind="animal" id={id} size={56} />
                </View>
                <Text style={[styles.label, { color: themed.slate }]}>
                  {ANIMALS[id]?.meta.name ?? id}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  back: { width: 32, paddingVertical: 4 },
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  title: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
  },
  content: { padding: 16 },
  helper: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cell: {
    width: '31.5%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    gap: 4,
  },
  label: {
    fontFamily: font.regular,
    fontSize: 11,
  },
});
