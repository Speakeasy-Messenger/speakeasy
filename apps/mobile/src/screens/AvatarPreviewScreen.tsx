import React from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../theme/index.js';
import { font, type as typeScale, space } from '../theme/tokens.js';
import { ANIMAL_IDS, ANIMALS } from '../avatars/components.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { Handle } from '../components/Handle.js';

/**
 * Hidden dev preview — every primitive from the Phase-1 brand
 * foundation, in a single scroll. Verify against the
 * `speakeasy-animals.html` and `speakeasy-conversations.html` references
 * before wiring real screens.
 *
 * Reachable from the Diagnostics screen until Phase 6 cleanup.
 */

interface Props {
  onBack: () => void;
}

export function AvatarPreviewScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();

  // A handful of made-up room IDs to show variety in RoomMark output.
  const roomIds = [
    'grp-thursday-crew-9f3a',
    'grp-family-1c20',
    'grp-side-project-a481',
    'grp-book-club-3b29',
  ];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <View style={[styles.header, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={[styles.back, { color: themed.primary }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Avatar preview</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.section, { color: themed.slate }]}>HANDLES</Text>
        <View style={styles.handleRow}>
          <Handle value="bento" variant="body" />
          <Handle value="amber" variant="subtitle" />
          <Handle value="lyra" variant="display" />
        </View>

        <Text style={[styles.section, { color: themed.slate, marginTop: space.lg }]}>
          ROOM MARKS
        </Text>
        <View style={styles.row}>
          {roomIds.map((id) => (
            <View key={id} style={styles.cell}>
              <PortraitTile kind="room" id={id} size={64} />
              <Text style={[styles.cellLabel, { color: themed.slate }]}>{id.slice(4, 18)}</Text>
            </View>
          ))}
        </View>

        <Text style={[styles.section, { color: themed.slate, marginTop: space.lg }]}>
          ANIMALS — IDLE (BREATHING + BLINK)
        </Text>
        <View style={styles.grid}>
          {ANIMAL_IDS.map((id) => (
            <View key={id} style={styles.gridCell}>
              <PortraitTile kind="animal" id={id} size={88} />
              <Text style={[styles.cellLabel, { color: themed.slate }]}>
                {ANIMALS[id]?.meta.name ?? id}
              </Text>
            </View>
          ))}
        </View>

        <Text style={[styles.section, { color: themed.slate, marginTop: space.lg }]}>
          SIZES — FOX
        </Text>
        <View style={styles.row}>
          {[18, 28, 36, 64, 96].map((s) => (
            <View key={s} style={styles.cell}>
              <PortraitTile kind="animal" id="fox" size={s} skipBlink />
              <Text style={[styles.cellLabel, { color: themed.slate }]}>{s}px</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingHorizontal: space.lg,
    paddingTop: space.m,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  title: {
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
  },
  content: { padding: space.lg, gap: space.s },
  section: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
  handleRow: { gap: space.s },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  cell: { alignItems: 'center', gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  gridCell: { alignItems: 'center', gap: 4, width: '22%' },
  cellLabel: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
  },
});
