import React, { useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Attachment } from '@speakeasy/shared';
import { accent, brand, font, space, type } from '../theme/tokens.js';

/**
 * Fullscreen photo/GIF viewer — tap a chat photo bubble routes here.
 * Brand-canvas (aubergine) backdrop so the image is the focus; brass
 * tap-to-close affordance in the top left.
 *
 * Gallery: receives ALL the viewable (image/gif) attachments in the
 * conversation, in chat order, and opens at the tapped one. Swipe
 * left/right pages to the previous/next picture in that chat — a
 * horizontal `pagingEnabled` FlatList (virtualized, so only the pages
 * near the current index hold a decoded base64 image in memory). The
 * "n / m" counter and Save target track the page you're on.
 *
 * Pinch-to-zoom is still deferred (would need react-native-gesture-
 * handler + reanimated; the priority is "I can see the photo at actual
 * size + flip through the chat's photos", not gallery-grade zoom).
 */
interface Props {
  /** Viewable attachments (image/gif) in the conversation, in chat order. */
  items: Attachment[];
  /** Index within `items` of the attachment the user tapped. */
  initialIndex: number;
  onClose: () => void;
  /**
   * Optional save callback for the CURRENTLY-shown image. When provided,
   * a "Save" affordance appears in the top bar. Parent wires this to the
   * same `saveAndAnnounceFile` path the file-attachment tap uses.
   * Omit on read-only viewers to hide the button.
   */
  onSave?: (attachment: Attachment) => void;
}

export function MediaViewerScreen({
  items,
  initialIndex,
  onClose,
  onSave,
}: Props): React.JSX.Element {
  const { width } = useWindowDimensions();
  // Clamp the start index defensively — a stale reference would otherwise
  // scroll to -1.
  const startIndex = initialIndex >= 0 && initialIndex < items.length ? initialIndex : 0;
  const [index, setIndex] = useState(startIndex);
  const current = items[index] ?? items[startIndex];

  // Page index follows the settled scroll position. Rounding by screen
  // width is exact because every page is exactly one screen wide.
  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index && i >= 0 && i < items.length) setIndex(i);
  };

  const listRef = useRef<FlatList<Attachment>>(null);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.bar}>
        <Pressable onPress={onClose} hitSlop={12} testID="media-viewer-close">
          <Text style={styles.close}>‹ Close</Text>
        </Pressable>
        {items.length > 1 ? (
          <Text style={styles.counter} testID="media-viewer-counter">
            {index + 1} / {items.length}
          </Text>
        ) : null}
        {onSave ? (
          <Pressable
            onPress={() => current && onSave(current)}
            hitSlop={12}
            testID="media-viewer-save"
          >
            <Text style={styles.save}>Save</Text>
          </Pressable>
        ) : (
          // Keep the counter centered when there's no Save button.
          <View style={styles.barSpacer} />
        )}
      </View>
      <FlatList
        ref={listRef}
        data={items}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={startIndex}
        // Every page is one screen wide — gives FlatList an exact layout
        // so initialScrollIndex lands without a blank first frame.
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={onMomentumEnd}
        keyExtractor={(_, i) => String(i)}
        // Cap how many full-size base64 images are decoded/mounted at once.
        windowSize={3}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        renderItem={({ item }) => (
          <View style={[styles.page, { width }]}>
            <Image
              source={{ uri: `data:${item.mime};base64,${item.data}` }}
              style={styles.img}
              resizeMode="contain"
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas },
  bar: {
    paddingHorizontal: space.lg,
    paddingVertical: space.s,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  close: {
    color: accent.base, // brass — mode-invariant on brand canvas
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
  },
  counter: {
    color: 'rgba(242,233,216,0.7)', // muted cream on the aubergine canvas
    fontFamily: font.regular,
    fontSize: type.caption.size,
  },
  save: {
    color: accent.base,
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
  },
  // Matches the Save button's tap target so the counter stays centered
  // when Save is hidden.
  barSpacer: { width: 44 },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
});
