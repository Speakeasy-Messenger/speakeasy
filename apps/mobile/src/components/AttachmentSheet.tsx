import React, { useEffect } from 'react';
import {
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useColors } from '../theme/index.js';
import { font, scrim, space, type as typeScale } from '../theme/tokens.js';

/**
 * Attachment-type chooser. Three actions stacked vertically:
 *   - Photo (gallery, returns kind: 'image')
 *   - Camera (front/rear capture, returns kind: 'image')
 *   - File (document picker, returns kind: 'file')
 *
 * Renders inline (no <Modal>) — same pattern as FindSomeoneSheet
 * after rc.30 dropped Modal. Tap scrim or × to dismiss; Android
 * back is intercepted via BackHandler while visible.
 *
 * Earlier alphas wired the paperclip directly to the document picker,
 * which always returned `kind: 'file'` even when the user picked a
 * photo — meaning the receiving bubble showed a JPG file-icon
 * placeholder instead of the actual image. The split here makes the
 * intent explicit at picker time, so photo-by-design vs file-by-design
 * is unambiguous.
 */
interface Props {
  visible: boolean;
  onClose: () => void;
  onPickPhoto: () => void;
  onPickCamera: () => void;
  onPickFile: () => void;
}

export function AttachmentSheet({
  visible,
  onClose,
  onPickPhoto,
  onPickCamera,
  onPickFile,
}: Props): React.ReactElement {
  const themed = useColors();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!visible) return <View testID="attach-sheet-hidden" />;

  return (
    <View style={styles.overlay} testID="attach-sheet-overlay">
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: scrim.modal }]}
        onPress={onClose}
        testID="attach-sheet-scrim"
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: themed.cream, borderTopColor: themed.divider },
        ]}
        testID="attach-sheet"
      >
        <View style={styles.header}>
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={({ pressed }) => [
              styles.closeBtn,
              { borderColor: themed.divider },
              pressed && { backgroundColor: themed.soft },
            ]}
            testID="attach-sheet-close"
          >
            <Text style={[styles.closeGlyph, { color: themed.ink }]}>×</Text>
          </Pressable>
        </View>

        <Text style={[styles.title, { color: themed.ink }]}>
          Attach
          <Text style={{ color: themed.primary }}>.</Text>
        </Text>

        <View style={styles.options}>
          <AttachOption
            label="Photo"
            description="Pick from gallery."
            icon={<PhotoIcon color={themed.primary} />}
            onPress={() => {
              onClose();
              onPickPhoto();
            }}
            testID="attach-sheet-photo"
          />
          <AttachOption
            label="Camera"
            description="Take a new photo."
            icon={<CameraIcon color={themed.primary} />}
            onPress={() => {
              onClose();
              onPickCamera();
            }}
            testID="attach-sheet-camera"
          />
          <AttachOption
            label="Document"
            description="Any file, up to 800KB."
            icon={<DocumentIcon color={themed.primary} />}
            onPress={() => {
              onClose();
              onPickFile();
            }}
            testID="attach-sheet-file"
          />
        </View>
      </View>
    </View>
  );
}

interface OptionProps {
  label: string;
  description: string;
  icon: React.ReactElement;
  onPress: () => void;
  testID?: string;
}

function AttachOption({
  label,
  description,
  icon,
  onPress,
  testID,
}: OptionProps): React.ReactElement {
  const themed = useColors();
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.option,
        {
          backgroundColor: pressed ? themed.soft : themed.pale,
          borderColor: themed.divider,
        },
      ]}
    >
      <View style={[styles.optionIcon, { borderColor: themed.divider }]}>
        {icon}
      </View>
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, { color: themed.ink }]}>{label}</Text>
        <Text style={[styles.optionDesc, { color: themed.slate }]}>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

function PhotoIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={5}
        width={18}
        height={14}
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
      <Path
        d="M3 16 L9 11 L13 14 L17 10 L21 14"
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
      <Path d="M16 8 L18 8 L18 8" stroke={color} strokeWidth={2} fill={color} />
    </Svg>
  );
}

function CameraIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={6}
        width={18}
        height={13}
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
      <Path d="M9 6 L10 4 L14 4 L15 6" stroke={color} strokeWidth={1.6} fill="none" />
      <Path
        d="M12 16 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0"
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
    </Svg>
  );
}

function DocumentIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 3 L14 3 L20 9 L20 21 L6 21 Z"
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
      <Path d="M14 3 L14 9 L20 9" stroke={color} strokeWidth={1.6} fill="none" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    elevation: 1000,
    zIndex: 1000,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    paddingTop: space.base,
    paddingBottom: space.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.base,
    minHeight: 44,
  },
  grab: { width: 36, height: 3 },
  closeBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  closeGlyph: { fontFamily: font.regular, fontSize: 28, lineHeight: 30 },
  title: {
    fontFamily: font.bold,
    fontSize: 22,
    letterSpacing: -0.025 * 22,
    marginBottom: space.lg,
  },
  options: { gap: space.s },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.base,
    paddingHorizontal: space.base,
    paddingVertical: space.base,
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionText: { flex: 1, gap: space.xs },
  optionLabel: { fontFamily: font.medium, fontSize: 14 },
  optionDesc: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
});
