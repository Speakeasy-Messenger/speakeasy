import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Attachment } from '@speakeasy/shared';
import {
  downloadTenorGif,
  fetchTenorSearch,
  fetchTenorTrending,
  type TenorGifSummary,
} from '../attachments/tenor.js';
import { useColors } from '../theme/index.js';
import { fonts, radius, space, text as textStyles } from '../theme/index.js';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Fires when the user picks a GIF — host should send it as a chat
   * attachment. The host is responsible for closing the sheet. */
  onPick: (gif: Attachment) => void;
}

/**
 * Tenor-backed GIF picker. Modal sheet over the chat. Trending by
 * default; searches as the user types (debounced). Picks one ⇒ host
 * receives a fully-encoded `Attachment`, ready to drop into the
 * message envelope.
 *
 * Why a Modal and not a navigator screen: GIF-pick is an inline
 * compose action ("attach to current message"), not a destination
 * screen. The user's mental model is "open keyboard panel" — Modal
 * matches that affordance.
 */
export function GifPickerSheet({ visible, onClose, onPick }: Props) {
  const themed = useColors();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<TenorGifSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);

  // Re-fetch when the sheet opens or the search query changes.
  // Debounce by 300ms while typing so we don't slam Tenor on every
  // keystroke. Trending is the default when query is empty.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      const r = query.trim()
        ? await fetchTenorSearch(query)
        : await fetchTenorTrending();
      if (!cancelled) {
        setItems(r);
        setLoading(false);
      }
    }, query.trim() ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [visible, query]);

  // Reset query + items when the sheet closes — feels stale otherwise.
  useEffect(() => {
    if (!visible) {
      setQuery('');
      setItems([]);
    }
  }, [visible]);

  async function handlePick(summary: TenorGifSummary) {
    setPickingId(summary.id);
    const att = await downloadTenorGif(summary);
    setPickingId(null);
    if (att) onPick(att);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
    >
      <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={8} testID="gif-sheet-close">
            <Text style={[styles.cancel, { color: themed.primary }]}>Cancel</Text>
          </Pressable>
          <Text style={[textStyles.heroBody, { color: themed.ink }]}>GIFs</Text>
          <View style={{ width: 60 }} />
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search Tenor"
          placeholderTextColor={themed.slate}
          autoCorrect={false}
          autoCapitalize="none"
          style={[
            styles.search,
            { backgroundColor: themed.pale, color: themed.ink },
          ]}
          testID="gif-sheet-search"
        />

        {loading && items.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={themed.primary} />
          </View>
        ) : (
          <FlatList
            data={items}
            numColumns={2}
            keyExtractor={(g) => g.id}
            contentContainerStyle={styles.gridContent}
            columnWrapperStyle={styles.row}
            ListEmptyComponent={
              !loading ? (
                <Text
                  style={[
                    textStyles.subtitle,
                    { color: themed.slate, textAlign: 'center', marginTop: space.lg },
                  ]}
                >
                  {query.trim() ? 'No matches.' : 'No trending GIFs available.'}
                </Text>
              ) : null
            }
            renderItem={({ item }) => {
              const aspect = item.width / Math.max(item.height, 1);
              return (
                <Pressable
                  onPress={() => void handlePick(item)}
                  style={styles.cell}
                  testID={`gif-cell-${item.id}`}
                >
                  <Image
                    source={{ uri: item.previewUrl }}
                    style={[styles.gifImg, { aspectRatio: aspect || 1 }]}
                  />
                  {pickingId === item.id ? (
                    <View style={styles.pickingOverlay}>
                      <ActivityIndicator color={themed.cream} />
                    </View>
                  ) : null}
                </Pressable>
              );
            }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  cancel: { fontFamily: fonts.inter500, fontSize: 14 },
  search: {
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.pill,
    fontFamily: fonts.inter400,
    fontSize: 14,
  },
  gridContent: { padding: space.md, gap: space.xs },
  row: { gap: space.xs, marginBottom: space.xs },
  cell: {
    flex: 1,
    backgroundColor: '#00000010',
    borderRadius: radius.avatar,
    overflow: 'hidden',
  },
  gifImg: { width: '100%' },
  pickingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#00000060',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
