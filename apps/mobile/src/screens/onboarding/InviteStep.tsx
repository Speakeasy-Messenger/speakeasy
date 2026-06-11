import React, { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '../../components/Button.js';
import { Handle } from '../../components/Handle.js';
import { encodeAdd } from '../../utils/handle-link.js';
import { accent, brand, font, space, type as typeScale, workspace } from '../../theme/tokens.js';

/**
 * Onboarding screen 06 — Bring someone in.
 *
 * A messenger is empty until you reach someone, and Speakeasy has no
 * directory — a new user can finish onboarding and have nobody to talk
 * to. This is the first-run moment that turns sharing into the first
 * action: the user's @handle + a QR + Share, framed as "send this to a
 * friend." The link is the https Universal Link (encodeAdd), so the
 * recipient taps it to add you if they have the app, or lands on the
 * speakeasyapp.xyz/add page to install if they don't.
 *
 * Shown once — it lives inside onboarding (before the App-routing flip
 * to Conversations), so it never reappears for an enrolled user.
 *
 * Same brand-canvas layout as DoorStep / RoomStep / PermissionsStep.
 */

interface Props {
  handle: string;
  onContinue: () => void;
}

const BONE = workspace.dark.text;
const BRASS = accent.base;
const TEXT_MUTE = workspace.dark.textMute;
const QR_BONE = '#F2E9D8';
const QR_INK = '#1B1222';

export function InviteStep({ handle, onContinue }: Props): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const addUrl = encodeAdd(handle);

  function onCopy(): void {
    Clipboard.setString(handle);
    setCopied(true);
  }

  async function onShare(): Promise<void> {
    try {
      await Share.share({ message: `add me on speakeasy — @${handle}\n${addUrl}`, url: addUrl });
    } catch {
      // dismissed — nothing to do
    }
  }

  return (
    <SafeAreaView style={styles.root} testID="onboarding-invite">
      <View style={styles.content}>
        <Text style={styles.title}>
          Bring someone in<Text style={styles.dot}>.</Text>
        </Text>
        <Text style={styles.sub}>
          Speakeasy stays quiet until you reach someone — and there's no
          directory. Send your handle to a friend; they tap it to add you.
        </Text>

        <View style={styles.handleRow}>
          <Handle value={handle} variant="display" color={BONE} />
        </View>

        <View style={styles.qrFrame} testID="onboarding-invite-qr">
          <QRCode value={addUrl} size={168} color={QR_INK} backgroundColor={QR_BONE} ecl="Q" />
        </View>

        <View style={styles.actions}>
          <Pressable onPress={onCopy} hitSlop={8} testID="onboarding-invite-copy">
            <Text style={styles.action}>
              {copied ? 'Copied' : 'Copy handle'}
              <Text style={styles.dot}>.</Text>
            </Text>
          </Pressable>
          <Pressable onPress={() => void onShare()} hitSlop={8} testID="onboarding-invite-share">
            <Text style={styles.action}>
              Share<Text style={styles.dot}>.</Text>
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.bottom}>
        <Button
          label="Start messaging"
          onPress={onContinue}
          testID="onboarding-invite-continue"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas, paddingHorizontal: 24 },
  content: { flex: 1, paddingTop: 48, alignItems: 'center' },
  title: {
    fontFamily: font.bold,
    fontSize: 26,
    lineHeight: 30,
    color: BONE,
    letterSpacing: -0.025 * 26,
    marginBottom: 12,
    alignSelf: 'flex-start',
  },
  sub: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 18,
    color: TEXT_MUTE,
    marginBottom: 28,
    alignSelf: 'flex-start',
  },
  dot: { color: BRASS },
  handleRow: { marginBottom: 20 },
  qrFrame: {
    backgroundColor: QR_BONE,
    padding: 14,
    borderRadius: 4,
  },
  actions: { flexDirection: 'row', gap: 28, marginTop: 24 },
  action: {
    fontFamily: font.medium,
    fontSize: 15,
    color: BRASS,
  },
  bottom: { paddingBottom: 24, gap: space.s },
});
