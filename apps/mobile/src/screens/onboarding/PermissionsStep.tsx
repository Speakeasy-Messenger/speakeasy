import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button.js';
import { requestStartupPermissions } from '../../permissions/startup.js';
import { brand, font, type as typeScale } from '../../theme/tokens.js';

/**
 * Onboarding screen 05 — Notifications permission.
 *
 * After the Face step. One row explaining notifications, then a
 * single "Continue" button that fires the request. The user's
 * decision is owned by the OS — we don't gate further onboarding on
 * the grant. Denied can be re-granted via system Settings.
 *
 * Mic and camera moved to just-in-time prompts as of rc.51 — asked
 * at first call / first photo capture / first video call. See
 * `permissions/runtime.ts`. This step used to ask all three.
 *
 * Same brand-canvas layout as DoorStep / RoomStep so the visual
 * lineage stays coherent into the closing moments of onboarding.
 */

interface Props {
  onContinue: () => void;
}

const ITEMS: Array<{ title: string; sub: string }> = [
  {
    title: 'Notifications.',
    sub: "So you don't miss a message while the app is closed.",
  },
];

export function PermissionsStep({ onContinue }: Props): React.ReactElement {
  const [pending, setPending] = useState(false);

  async function handleContinue() {
    if (pending) return;
    setPending(true);
    try {
      await requestStartupPermissions();
    } finally {
      onContinue();
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <Text style={styles.title}>
          One thing from your phone<Text style={styles.dot}>.</Text>
        </Text>
        <Text style={styles.sub}>
          Speakeasy never asks for personal data. This is an OS permission
          your phone controls. Skip it and re-grant later from Settings.
        </Text>
        <View style={styles.list}>
          {ITEMS.map((p) => (
            <View key={p.title} style={styles.row}>
              <View style={styles.bullet} />
              <View style={styles.rowBody}>
                <Text style={styles.heading}>{p.title}</Text>
                <Text style={styles.body}>{p.sub}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.bottom}>
        <Button
          label={pending ? 'Asking…' : 'Continue'}
          onPress={() => void handleContinue()}
          disabled={pending}
          testID="onboarding-permissions-continue"
        />
      </View>
    </SafeAreaView>
  );
}

const BONE = '#F2E9D8';
const BRASS = '#E5A645';
const TEXT_MUTE = 'rgba(242,233,216,0.55)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas, paddingHorizontal: 24 },
  content: { flex: 1, paddingTop: 48 },
  title: {
    fontFamily: font.bold,
    fontSize: 26,
    lineHeight: 30,
    color: BONE,
    letterSpacing: -0.025 * 26,
    marginBottom: 12,
  },
  sub: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 18,
    color: TEXT_MUTE,
    marginBottom: 32,
  },
  dot: { color: BRASS },
  list: { gap: 20 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  bullet: { width: 6, height: 6, backgroundColor: BRASS, marginTop: 8 },
  rowBody: { flex: 1, gap: 2 },
  heading: {
    fontFamily: font.medium,
    fontSize: 18,
    color: BONE,
    letterSpacing: -0.005 * 18,
  },
  body: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: TEXT_MUTE,
    lineHeight: 16,
  },
  bottom: { paddingBottom: 24 },
});
