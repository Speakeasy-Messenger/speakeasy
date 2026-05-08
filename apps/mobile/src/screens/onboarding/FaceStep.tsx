import React, { useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button } from '../../components/Button.js';
import { PortraitTile } from '../../components/PortraitTile.js';
import { ANIMAL_IDS } from '../../avatars/components.js';
import { api } from '../../services.js';
import { useColors } from '../../theme/index.js';
import { brand, font, motion, type as typeScale } from '../../theme/tokens.js';
import { diag } from '../../diag/log.js';

/**
 * Onboarding screen 04 — Face.
 * Spec: ONBOARDING.md §2.4 (+ AVATAR-SYSTEM.md §6.1).
 *
 * 3×4 grid of the 12 launch animals, on the brand canvas. Selected
 * tile gets a 2px brass border. Primary button "Open the door" stays
 * disabled until a selection is made.
 *
 * On accept: persist the choice via `api.setAvatar(deviceToken,
 * animalId)` and call `onPicked` so the parent can flip the navigator
 * over to the conversation list (with the canvas crossfade).
 */

interface Props {
  /** Set on step 03's enroll. We don't have it in the identity store
   * yet (parent defers the setUserId until the face is picked, so the
   * App.tsx routing doesn't jump to the conversation list mid-flow). */
  deviceToken: string;
  onPicked: (animalId: string) => void;
}

export function FaceStep({ deviceToken, onPicked }: Props): React.ReactElement {
  const themed = useColors();
  const [selected, setSelected] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Spec §2.4: "Canvas crossfade: on tap, the brand canvas fades to
  // workspace canvas (dark or light per OS) over 240ms. This is the
  // only canvas crossfade in the entire app."
  //
  // Implementation: the FaceStep renders on `brand.canvas` aubergine.
  // On confirm, we fade in an absolute-positioned overlay that's the
  // *workspace* canvas color over `motion.screen` (240ms). When the
  // animation completes we call `onPicked`, which is what triggers
  // identity.setUserId in the parent — App.tsx then swaps the
  // navigator stack from Onboarding to Authed. By the time the
  // navigator renders the conversation list, our overlay has already
  // painted the matching canvas color, so the visible transition is
  // a single continuous crossfade rather than a hard cut.
  const crossfade = useRef(new Animated.Value(0)).current;

  async function handleConfirm() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.setAvatar(deviceToken, selected);
      // Run the crossfade BEFORE onPicked. Once onPicked fires the
      // navigator swaps stacks; if we haven't faded the overlay in
      // by then, the user sees aubergine → snap → workspace.
      Animated.timing(crossfade, {
        toValue: 1,
        duration: motion.screen,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onPicked(selected);
      });
    } catch (err) {
      diag('onboarding', 'setAvatar failed', { err: String(err) });
      // Keep the user on this screen — they picked a face, the server
      // didn't accept it. Surfacing inline lets them retry.
      setError(`Could not save face. Try again? (${String(err)})`);
      setBusy(false);
      return;
    }
    // Don't reset busy after a successful path — the overlay stays
    // up until onPicked fires the navigator swap, and we don't want
    // a flicker of the disabled button as it un-disables.
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>
          Choose your face<Text style={styles.dot}>.</Text>
        </Text>
        <Text style={styles.subtitle}>Animals only. You can change it anytime.</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.grid}>
          {ANIMAL_IDS.map((id) => {
            const isSelected = id === selected;
            return (
              <Pressable
                key={id}
                onPress={() => setSelected(id)}
                hitSlop={2}
                style={[
                  styles.cell,
                  {
                    backgroundColor: brand.surface,
                    borderColor: isSelected ? BRASS : TEXT_FAINT,
                    borderWidth: isSelected ? 2 : 1,
                  },
                ]}
                testID={`onboarding-face-${id}`}
              >
                <PortraitTile kind="animal" id={id} size={64} skipBlink />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View style={styles.bottom}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button
          label="Open the door"
          onPress={() => void handleConfirm()}
          disabled={!selected || busy}
          loading={busy}
          testID="onboarding-face-confirm"
        />
      </View>

      {/* Spec §2.4 canvas crossfade overlay. Workspace canvas color
          fades in over 240ms; on completion onPicked fires which
          swaps the navigator stacks. The overlay sits absolute on
          top of the brand-canvas content; while opacity < 1 the
          aubergine bleeds through, while opacity = 1 the user
          visually sees the workspace canvas before the actual
          conversation list mounts. pointerEvents="none" so the
          fade doesn't intercept any in-flight taps (in practice
          the button is disabled by `busy` anyway). */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: themed.cream, opacity: crossfade },
        ]}
        testID="onboarding-canvas-crossfade"
      />
    </SafeAreaView>
  );
}

const BONE = '#F2E9D8';
const BRASS = '#E5A645';
const TEXT_MUTE = 'rgba(242,233,216,0.55)';
const TEXT_FAINT = 'rgba(242,233,216,0.12)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas },
  header: { paddingHorizontal: 24, paddingTop: 48 },
  title: {
    fontFamily: font.bold,
    fontSize: 26,
    letterSpacing: -0.025 * 26,
    color: BONE,
    marginBottom: 8,
  },
  dot: { color: BRASS },
  subtitle: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: TEXT_MUTE,
    marginBottom: 24,
    maxWidth: 30 * 8,
  },
  content: { paddingHorizontal: 24, paddingBottom: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell: {
    width: '31.5%', // ≈ 3 columns with 6px gaps in a 24-padded container
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 8 },
  error: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: BONE,
  },
});
