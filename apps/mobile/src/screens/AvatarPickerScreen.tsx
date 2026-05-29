import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ANIMALS } from '../avatars/components.js';
import {
  CATALOG,
  FREE_AVATARS,
  LEGENDARIES,
  RARES,
  type AvatarDescriptor,
} from '../avatars/catalog.js';
import { AcquireSheet } from '../components/AcquireSheet.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { api } from '../services.js';
import { useIdentity } from '../store/identity.js';
import { useOwnership } from '../store/ownership.js';
import { useProfiles } from '../store/profiles.js';
import { useColors } from '../theme/index.js';
import { accent, font, space } from '../theme/tokens.js';
import { AppBar } from '../components/AppBar.js';
import { diag } from '../diag/log.js';

interface Props {
  onBack: () => void;
}

/**
 * AVATARSTORE.md §6 + SETTINGS.md §7 — avatar picker drilldown.
 *
 * Three sections, in order:
 *   1. Yours — every avatar the user can wear today: 12 free + any
 *      owned rares/legendaries.
 *   2. Rare — locked rares ($9.99 each). Unowned only; tapping
 *      opens the AcquireSheet.
 *   3. Legendary — locked legendaries ($99.99 each). Same pattern,
 *      with the per-animal signature color hinted on the lock badge.
 *
 * Optimistic local write rolls back on server failure (existing
 * behavior — paid avatars work the same way).
 */
export function AvatarPickerScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const userId = useIdentity((s) => s.userId);
  const ownProfile = useProfiles((s) =>
    userId ? s.byUserId[userId] : undefined,
  );
  const setProfile = useProfiles((s) => s.set);
  const ownedSkus = useOwnership((s) => s.ownedSkus);
  const restore = useOwnership((s) => s.restore);
  const selected = ownProfile?.selectedAvatarId;
  const [busy, setBusy] = useState(false);
  const [acquiring, setAcquiring] = useState<string | null>(null);

  const owned = useMemo(() => {
    // "Yours" = free 12 + any rare/legendary whose sku is in ownedSkus.
    const paid = [...RARES, ...LEGENDARIES].filter(
      (e) => e.skuId && ownedSkus[e.skuId],
    );
    return [...FREE_AVATARS, ...paid];
  }, [ownedSkus]);

  // Diagnostic: surface what the picker actually sees so subsequent
  // "the payment sheet didn't show" reports tell us whether the bug
  // is in the picker (paid avatar appearing as Owned, no AcquireSheet
  // dispatch) or in the sheet (sheet rendered but no native dialog).
  useEffect(() => {
    diag('picker', 'mounted', {
      ownedSkuCount: Object.keys(ownedSkus).length,
      lockedRares: RARES.filter((e) => e.skuId && !ownedSkus[e.skuId]).length,
      lockedLegendaries: LEGENDARIES.filter((e) => e.skuId && !ownedSkus[e.skuId]).length,
      selected,
    });
  }, [ownedSkus, selected]);

  const lockedRares = useMemo(
    () => RARES.filter((e) => !e.skuId || !ownedSkus[e.skuId]),
    [ownedSkus],
  );
  const lockedLegendaries = useMemo(
    () => LEGENDARIES.filter((e) => !e.skuId || !ownedSkus[e.skuId]),
    [ownedSkus],
  );

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

  function handleAcquired(animalId: string) {
    setAcquiring(null);
    // Auto-select the just-acquired avatar — it's the natural intent
    // after a buy. The setProfile call inside handlePick echoes
    // through to the server.
    void handlePick(animalId);
  }

  function openAcquireSheet(animalId: string) {
    if (busy || acquiring) return;
    setAcquiring(animalId);
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="avatar-picker-screen"
    >
      <AppBar onBack={onBack} title="Change my face" testID="avatar-picker-appbar" />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.helper, { color: themed.slate }]}>
          Pick a different animal. Anyone you've shared your handle with
          sees the new face on their next refresh.
        </Text>

        <SectionHeader label="Yours" themed={themed} />
        <View style={styles.grid}>
          {owned.map((entry) => (
            <OwnedTile
              key={entry.id}
              entry={entry}
              active={entry.id === selected}
              busy={busy}
              themed={themed}
              onPress={() => {
                diag('picker', 'tap owned tile', { id: entry.id, tier: entry.tier });
                // Paid avatars (even already-owned) route through
                // AcquireSheet for confirmation. The sheet renders
                // "Wear {Name}" instead of "Confirm purchase" when
                // it sees an already-owned id. This sidesteps the
                // "no payment page exposed" class of bugs where
                // ownership state pollution caused paid avatars to
                // silently bypass the sheet.
                if (entry.tier !== 'free') {
                  openAcquireSheet(entry.id);
                } else {
                  void handlePick(entry.id);
                }
              }}
            />
          ))}
        </View>

        {lockedRares.length > 0 ? (
          <>
            <SectionHeader label="Rare" themed={themed} testID="picker-section-rare" />
            <View style={styles.grid}>
              {lockedRares.map((entry) => (
                <LockedTile
                  key={entry.id}
                  entry={entry}
                  busy={busy || acquiring !== null}
                  themed={themed}
                  onPress={() => {
                    diag('picker', 'tap locked rare', { id: entry.id });
                    openAcquireSheet(entry.id);
                  }}
                />
              ))}
            </View>
          </>
        ) : null}

        {lockedLegendaries.length > 0 ? (
          <>
            <SectionHeader
              label="Legendary"
              themed={themed}
              testID="picker-section-legendary"
            />
            <View style={styles.grid}>
              {lockedLegendaries.map((entry) => (
                <LockedTile
                  key={entry.id}
                  entry={entry}
                  busy={busy || acquiring !== null}
                  themed={themed}
                  onPress={() => {
                    diag('picker', 'tap locked legendary', { id: entry.id });
                    openAcquireSheet(entry.id);
                  }}
                />
              ))}
            </View>
          </>
        ) : null}

        <Pressable
          onPress={() => void restore()}
          hitSlop={8}
          style={styles.restoreWrap}
          testID="picker-restore"
        >
          <Text style={[styles.restoreText, { color: themed.slate }]}>
            Restore purchases
          </Text>
        </Pressable>
      </ScrollView>

      <AcquireSheet
        visible={acquiring !== null}
        animalId={acquiring}
        onClose={() => setAcquiring(null)}
        onAcquired={handleAcquired}
      />
    </SafeAreaView>
  );
}

function SectionHeader({
  label,
  themed,
  testID,
}: {
  label: string;
  themed: ReturnType<typeof useColors>;
  testID?: string;
}): React.ReactElement {
  return (
    <View style={styles.sectionHeader} testID={testID}>
      <View style={[styles.sectionRule, { backgroundColor: themed.divider }]} />
      <Text style={[styles.sectionLabel, { color: themed.slate }]}>
        {label}
      </Text>
      <View style={[styles.sectionRule, { backgroundColor: themed.divider }]} />
    </View>
  );
}

function OwnedTile({
  entry,
  active,
  busy,
  themed,
  onPress,
}: {
  entry: AvatarDescriptor;
  active: boolean;
  busy: boolean;
  themed: ReturnType<typeof useColors>;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={2}
      disabled={busy}
      style={[
        styles.cell,
        {
          backgroundColor: themed.pale,
          borderColor: active ? themed.primary : themed.divider,
        },
      ]}
      testID={`avatar-pick-${entry.id}`}
    >
      <View style={{ transform: [{ scale: active ? 1.1 : 1.0 }] }}>
        <PortraitTile kind="animal" id={entry.id} size={56} />
      </View>
      <Text style={[styles.label, { color: themed.slate }]}>
        {ANIMALS[entry.id]?.meta.name ?? entry.name}
      </Text>
    </Pressable>
  );
}

function LockedTile({
  entry,
  busy,
  themed,
  onPress,
}: {
  entry: AvatarDescriptor;
  busy: boolean;
  themed: ReturnType<typeof useColors>;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={2}
      disabled={busy}
      style={[
        styles.cell,
        {
          backgroundColor: themed.pale,
          borderColor: themed.divider,
        },
        busy && styles.disabledCell,
      ]}
      testID={`avatar-locked-${entry.id}`}
    >
      <View style={styles.lockedTint}>
        <PortraitTile kind="animal" id={entry.id} size={56} />
      </View>
      <View
        style={[
          styles.priceChip,
          { backgroundColor: accent.base, borderColor: themed.divider },
        ]}
      >
        <Text style={styles.priceText}>{entry.displayPrice}</Text>
      </View>
      <Text style={[styles.label, { color: themed.slate }]}>{entry.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  helper: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    marginTop: space.lg,
    marginBottom: space.m,
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  sectionLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 11 * 0.18,
    textTransform: 'uppercase',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.s,
  },
  cell: {
    width: '31.5%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    gap: space.xs,
    position: 'relative',
  },
  label: {
    fontFamily: font.regular,
    fontSize: 11,
  },
  lockedTint: {
    opacity: 0.45,
  },
  priceChip: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingHorizontal: space.s,
    paddingVertical: space.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  priceText: {
    fontFamily: font.medium,
    fontSize: 9,
    letterSpacing: 0.2,
    color: accent.foreground,
  },
  disabledCell: {
    opacity: 0.7,
  },
  restoreWrap: {
    alignSelf: 'center',
    paddingVertical: space.lg,
    marginTop: space.m,
  },
  restoreText: {
    fontFamily: font.regular,
    fontSize: 12,
    textDecorationLine: 'underline',
  },
});

// Suppress unused warning — `CATALOG` import keeps the catalog
// reachable through this module's public dependency graph for any
// follow-on consumers (tests do their own imports).
void CATALOG;
