import React, { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { accent, brand, font, space, type as typeScale, workspace } from '../theme/tokens.js';
import { encodeAdd } from '../utils/handle-link.js';

/**
 * NEW-CONVERSATION.md §5 — Share your handle.
 *
 * Brand canvas (aubergine) — one of the few brand moments outside
 * onboarding. The user is presenting their identity: animal portrait
 * over a `brand.surface` tile, handle in display style with brass
 * `@`, 200×200 QR encoding the deep link, two actions stacked at
 * the bottom (Copy + Share via…). Sharp corners throughout.
 *
 * Reachable per spec §5.5 from:
 *   - Empty conversation list "TAP TO SHARE"
 *   - Long-press own handle in any AppBar
 *   - Settings → Account → Share my handle
 */

interface Props {
  onBack: () => void;
}

export function ShareHandleScreen({ onBack }: Props): React.ReactElement {
  const myUserId = useIdentity((s) => s.userId);
  const ownProfile = useProfiles((s) =>
    myUserId ? s.byUserId[myUserId] : undefined,
  );
  const animalId =
    ownProfile?.selectedAvatarId ??
    (myUserId ? defaultAnimalForUser(myUserId) : 'fox');

  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  if (!myUserId) {
    // Defensive — this screen is only routable when enrolled.
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.bone}>Not enrolled.</Text>
      </SafeAreaView>
    );
  }

  // Spec §5.4 Copy: bare handle, not the URL. The user is most
  // likely to paste this into a chat with someone, where the bare
  // form is what they'd type.
  function handleCopy() {
    Clipboard.setString(myUserId!);
    setCopiedAt(Date.now());
    setTimeout(() => setCopiedAt(null), 2000);
  }

  // Spec §5.4 Share via…: include a real download path. The
  // `speakeasy://add?handle=…` deep link only works for users who
  // already have the app, so until we have App Store / Play Store
  // listings the recipient gets the GitHub releases/latest link
  // (always points at the newest tagged APK) — same pattern the
  // old InviteFriends flow used. The deep link is dropped: it
  // resolves to nothing for new users and the share-sheet preview
  // turns the text into a dead-looking URL.
  async function handleShare() {
    const downloadUrl =
      'https://github.com/Speakeasy-Messenger/speakeasy/releases/latest';
    try {
      await Share.share({
        message: `join me on speakeasy: my handle is @${myUserId}.\ndownload: ${downloadUrl}`,
        url: downloadUrl,
      });
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }

  return (
    <SafeAreaView style={styles.root} testID="share-handle-screen">
      <View style={styles.headerBar}>
        <Pressable onPress={onBack} hitSlop={8} testID="share-handle-back">
          <Text style={styles.back}>‹</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={styles.eyebrow}>YOUR HANDLE</Text>

        <PortraitTile kind="animal" id={animalId} size={64} />

        <View style={styles.handleRow}>
          <Handle value={myUserId} variant="display" color={BONE} />
        </View>

        {/* QR encodes the deep link per spec §5.2. ~25% error
            correction (Q) supports the future Cipher S center
            overlay; for now we render plain ink-on-bone. */}
        <View style={styles.qrFrame} testID="share-handle-qr">
          <QRCode
            value={encodeAdd(myUserId)}
            size={200 - 28}
            color={INK}
            backgroundColor={BONE}
            ecl="Q"
          />
        </View>

        {copiedAt ? (
          <Text style={styles.copied} testID="share-handle-copied">
            copied<Text style={{ color: BRASS }}>.</Text>
          </Text>
        ) : (
          <View style={styles.copiedSpacer} />
        )}
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={handleCopy}
          style={styles.btnSecondary}
          testID="share-handle-copy"
        >
          <Text style={styles.btnSecondaryText}>Copy handle</Text>
        </Pressable>
        <Pressable
          onPress={() => void handleShare()}
          style={styles.btnPrimary}
          testID="share-handle-share"
        >
          <Text style={styles.btnPrimaryText}>Share via…</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const BRASS = accent.base;
const BONE = workspace.dark.text;
const INK = accent.foreground;
const TEXT_MUTE = workspace.dark.textMute;
const TEXT_FAINT = workspace.dark.textFaint;

const styles = StyleSheet.create({
  // Brand canvas — never themed. The share screen is mode-invariant
  // because it's a brand presentation surface (per spec §5.3).
  root: { flex: 1, backgroundColor: brand.canvas },
  headerBar: {
    paddingHorizontal: space.xl,
    paddingTop: space.base,
    paddingBottom: space.xs,
  },
  back: {
    fontFamily: font.regular,
    fontSize: 28,
    color: TEXT_MUTE,
    lineHeight: 28,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
  },
  eyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    color: TEXT_MUTE,
    marginBottom: space.lg,
  },
  handleRow: {
    marginTop: space.base,
    marginBottom: space.xxl,
  },
  // 200×200 frame, bone background, 16px quiet-zone padding per spec.
  qrFrame: {
    width: 200,
    height: 200,
    backgroundColor: BONE,
    padding: space.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copied: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: TEXT_MUTE,
    marginTop: space.base,
  },
  copiedSpacer: { height: 16 + typeScale.caption.size },
  actions: {
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
    gap: space.s,
  },
  btnPrimary: {
    backgroundColor: BRASS,
    paddingVertical: space.base,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: INK,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    paddingVertical: space.base,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: TEXT_FAINT,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: BONE,
    letterSpacing: 0.5,
  },
  bone: { color: BONE, fontFamily: font.regular, padding: 24 },
});
