import React, { useEffect } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button.js';
import { signalProtocol } from '../../services.js';
import { accent, brand, font, type as typeScale, workspace } from '../../theme/tokens.js';
import { diag } from '../../diag/log.js';

/**
 * Onboarding screen 02 — The room.
 * Spec: ONBOARDING.md §2.2.
 *
 * Three principles, each prefaced with a 6×6 brass square:
 *   ■ No name required.
 *      No phone, no email. Pick a handle, or let us.
 *   ■ No photo stored.
 *      Calls show an animal, not your face.
 *   ■ No record kept.
 *      Messages leave on a timer.
 *
 * Behind the screen: kicks off device-bound keypair generation (spec
 * §2.2 "silent work"). The native module persists into SQLCipher and
 * subsequent calls are idempotent, so re-mounts after background+resume
 * cost an extra keypair generation but no user-visible breakage. The
 * actual `api.enroll` call doesn't happen until step 03.
 */

interface Props {
  onContinue: () => void;
}

const PRINCIPLES: Array<{ title: string; sub: string }> = [
  { title: 'No name required.', sub: 'No phone, no email. Pick a handle, or let us.' },
  { title: 'No photo stored.', sub: 'Calls show an animal, not your face.' },
  { title: 'No record kept.', sub: 'Messages leave on a timer.' },
];

export function RoomStep({ onContinue }: Props): React.ReactElement {
  useEffect(() => {
    // Kick off the identity-key generation in the background while the
    // user reads. The native module's `generateIdentityKey` is
    // idempotent + persists into SQLCipher, so this is safe to run
    // unconditionally. No await — we don't gate Continue on completion
    // (step 03 awaits the result before claiming the handle).
    void signalProtocol.generateIdentityKey().catch((err) => {
      diag('onboarding', 'identity-key warmup failed (non-fatal)', { err: String(err) });
    });
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <Text style={styles.title}>
          The room remembers nothing<Text style={styles.dot}>.</Text>
        </Text>
        <View style={styles.list}>
          {PRINCIPLES.map((p) => (
            <View key={p.title} style={styles.row}>
              <View style={styles.bullet} />
              <View style={styles.rowBody}>
                <Text style={styles.principle}>{p.title}</Text>
                <Text style={styles.principleSub}>{p.sub}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.bottom}>
        <Button label="Step inside" onPress={onContinue} testID="onboarding-room-continue" />
      </View>
    </SafeAreaView>
  );
}

const BONE = workspace.dark.text;
const BRASS = accent.base;
const TEXT_MUTE = workspace.dark.textMute;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas, paddingHorizontal: 24 },
  content: { flex: 1, paddingTop: 48 },
  title: {
    fontFamily: font.bold,
    fontSize: 26,
    lineHeight: 30,
    color: BONE,
    letterSpacing: -0.025 * 26,
    marginBottom: 40,
  },
  dot: { color: BRASS },
  list: { gap: 20 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  // Spec §2.2: a real 6×6 brass square (NOT a bullet character). Mode-
  // invariant — same on aubergine, dark workspace, light workspace.
  bullet: { width: 6, height: 6, backgroundColor: BRASS, marginTop: 8 },
  rowBody: { flex: 1, gap: 2 },
  principle: {
    fontFamily: font.medium,
    fontSize: 18,
    color: BONE,
    letterSpacing: -0.005 * 18,
  },
  principleSub: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: TEXT_MUTE,
    lineHeight: 16,
  },
  bottom: { paddingBottom: 24 },
});
