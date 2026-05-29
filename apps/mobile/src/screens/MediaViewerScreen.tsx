import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { accent, brand, font, space, type } from '../theme/tokens.js';

/**
 * Fullscreen photo/GIF viewer — tap on a chat photo bubble routes
 * here. Brand-canvas (aubergine) backdrop so the image is the focus;
 * brass tap-to-close affordance in the top right.
 *
 * Pinch-to-zoom is deferred (would need react-native-gesture-handler
 * + reanimated; the alpha priority is "I can see the photo at
 * actual size", not gallery-grade zoom).
 */
interface Props {
  /** base64 bytes of the image. */
  data: string;
  mime: string;
  onClose: () => void;
  /**
   * Optional save callback. When provided, a "Save" affordance
   * appears in the top bar. Parent wires this to the same
   * `saveAndAnnounceFile` path the file-attachment tap uses — the
   * image lands in the app's external storage and (on Android, via
   * MediaStore.scanFile) shows up in the system gallery.
   *
   * Omit on read-only viewers (e.g. previewing your own outgoing
   * attachment before send) to hide the button.
   */
  onSave?: () => void;
}

export function MediaViewerScreen({ data, mime, onClose, onSave }: Props): React.JSX.Element {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.bar}>
        <Pressable onPress={onClose} hitSlop={12} testID="media-viewer-close">
          <Text style={styles.close}>‹ Close</Text>
        </Pressable>
        {onSave ? (
          <Pressable onPress={onSave} hitSlop={12} testID="media-viewer-save">
            <Text style={styles.save}>Save</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.imgWrap}>
        <Image
          source={{ uri: `data:${mime};base64,${data}` }}
          style={styles.img}
          resizeMode="contain"
        />
      </View>
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
  save: {
    color: accent.base,
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
  },
  imgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
});
