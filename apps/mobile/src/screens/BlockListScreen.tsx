import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { Handle } from '../components/Handle.js';
import { PeepholeMark } from '../components/PeepholeMark.js';
import { BlockConfirmSheet, UnblockConfirmSheet } from '../components/BlockSheets.js';
import { FindSomeoneSheet } from '../components/FindSomeoneSheet.js';
import { useBlocks } from '../store/blocks.js';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
}

/**
 * BLOCK.md §7 — block list (Settings → Privacy → Blocked).
 *
 * List of blocked handles, each row: 32×32 Peephole tile + handle +
 * "blocked Xd ago" caption + brass "unblock" link. Empty state
 * centered: 56×56 Peephole at 60% opacity + "No one's blocked." +
 * helper line. Bottom helper restates the privacy property.
 */
export function BlockListScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  // Subscribe to the underlying map (stable reference across no-op
  // updates), then derive the sorted list locally. Calling
  // `s.list()` directly inside the selector returned a fresh sorted
  // array every render, which made Zustand's getSnapshot comparator
  // see a new value on each pass → infinite re-render loop, crashing
  // the screen on first mount.
  const byHandle = useBlocks((s) => s.byHandle);
  const list = useMemo(
    () =>
      Object.values(byHandle).sort((a, b) => b.blockedAt - a.blockedAt),
    [byHandle],
  );
  const block = useBlocks((s) => s.block);
  const unblock = useBlocks((s) => s.unblock);
  const [unblockTarget, setUnblockTarget] = useState<string | undefined>();
  const [findOpen, setFindOpen] = useState(false);
  // BURN.md §11.5: when burn closes a 1:1 conversation, the user
  // can no longer reach the conversation-settings → Danger entry.
  // The "Block someone" row at the top of this screen + find-sheet
  // in block mode is the standalone block path.
  const [blockTarget, setBlockTarget] = useState<string | undefined>();

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="block-list-screen"
    >
      <AppBar onBack={onBack} title="Blocked" testID="block-list-appbar" />

      {/* BURN.md §11.5: "Block someone" entry at the top — opens
          the find sheet in block mode. The find sheet's result-card
          tap fires onPickBlock, which lifts the BlockConfirmSheet
          here. */}
      <Pressable
        onPress={() => setFindOpen(true)}
        style={({ pressed }) => [
          styles.blockSomeoneRow,
          {
            borderBottomColor: themed.divider,
            backgroundColor: pressed ? themed.soft : 'transparent',
          },
        ]}
        testID="block-list-block-someone"
      >
        <View
          style={[
            styles.peepholeTile,
            { backgroundColor: themed.pale, borderColor: themed.divider },
          ]}
        >
          <Text style={[styles.plusGlyph, { color: themed.primary }]}>+</Text>
        </View>
        <Text style={[styles.blockSomeoneLabel, { color: themed.ink }]}>
          Block someone
        </Text>
      </Pressable>

      {list.length === 0 ? (
        <View style={styles.emptyWrap}>
          <PeepholeMark size={56} opacity={0.6} />
          <Text style={[styles.emptyTitle, { color: themed.ink }]}>
            No one's blocked
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <Text style={[styles.emptySub, { color: themed.slate }]}>
            Block someone from their conversation settings, or tap above.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.countWrap}>
            <Text style={[styles.countLabel, { color: themed.slate }]}>
              {list.length} BLOCKED
            </Text>
          </View>
          <FlatList
            data={list}
            keyExtractor={(b) => b.handle}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <View
                style={[styles.row, { borderBottomColor: themed.divider }]}
                testID={`block-list-row-${item.handle}`}
              >
                <View
                  style={[
                    styles.peepholeTile,
                    {
                      backgroundColor: themed.pale,
                      borderColor: themed.divider,
                    },
                  ]}
                >
                  <PeepholeMark size={Math.round(32 * 0.78)} />
                </View>
                <View style={styles.body}>
                  <Handle value={item.handle} variant="body" />
                  <Text style={[styles.meta, { color: themed.slate }]}>
                    blocked {timeSince(item.blockedAt)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setUnblockTarget(item.handle)}
                  hitSlop={8}
                  testID={`block-list-unblock-${item.handle}`}
                >
                  <Text style={[styles.unblockLink, { color: themed.primary }]}>
                    unblock
                  </Text>
                </Pressable>
              </View>
            )}
            ListFooterComponent={
              <Text style={[styles.footnote, { color: themed.slate }]}>
                Blocked handles can't find you, message you, or call you. They
                aren't told they're blocked.
              </Text>
            }
          />
        </>
      )}

      <FindSomeoneSheet
        visible={findOpen}
        onClose={() => setFindOpen(false)}
        mode="block"
        onPickBlock={(handle) => setBlockTarget(handle)}
      />
      <BlockConfirmSheet
        visible={!!blockTarget}
        handle={blockTarget ?? ''}
        onClose={() => setBlockTarget(undefined)}
        onConfirm={() => {
          if (blockTarget) block(blockTarget);
          setBlockTarget(undefined);
        }}
      />
      <UnblockConfirmSheet
        visible={!!unblockTarget}
        handle={unblockTarget ?? ''}
        onClose={() => setUnblockTarget(undefined)}
        onConfirm={() => {
          if (unblockTarget) unblock(unblockTarget);
          setUnblockTarget(undefined);
        }}
      />
    </SafeAreaView>
  );
}

/**
 * Coarse "X ago" formatter per BLOCK.md §7.1: "3 days ago", "6
 * weeks ago", "2 months ago". Precision below the displayed unit
 * isn't useful in this surface.
 */
function timeSince(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  const days = Math.floor(seconds / 86400);
  if (days < 1) return 'today';
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // "Block someone" row — same geometry as a block-list row but
  // with a brass `+` glyph in place of the Peephole mark.
  blockSomeoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingHorizontal: space.base,
    paddingVertical: space.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  blockSomeoneLabel: {
    fontFamily: font.medium,
    fontSize: 14,
    flex: 1,
  },
  plusGlyph: {
    fontFamily: font.bold,
    fontSize: 18,
    lineHeight: 18,
  },
  countWrap: {
    paddingHorizontal: space.base,
    paddingTop: space.base,
    paddingBottom: space.m,
  },
  countLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
  listContent: { paddingBottom: space.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingHorizontal: space.base,
    paddingVertical: space.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  peepholeTile: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, gap: space.xs },
  meta: {
    fontFamily: font.regular,
    fontSize: 11,
    letterSpacing: 0.005,
  },
  unblockLink: {
    fontFamily: font.medium,
    fontSize: 12,
  },
  footnote: {
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 18,
    paddingHorizontal: space.base,
    paddingTop: space.xl,
    maxWidth: 32 * 8,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xxl,
    gap: space.lg,
  },
  emptyTitle: {
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: -0.005 * typeScale.subtitle.size,
  },
  emptySub: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    textAlign: 'center',
    maxWidth: 24 * 8,
    marginTop: -12,
  },
});
