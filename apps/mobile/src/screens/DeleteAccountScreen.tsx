import React from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Handle } from '../components/Handle.js';
import { PeepholeMark } from '../components/PeepholeMark.js';
import { useBlocks } from '../store/blocks.js';
import { useCalls } from '../store/calls.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { useSettings } from '../store/settings.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';
import { diag } from '../diag/log.js';

interface Props {
  onBack: () => void;
}

/**
 * SETTINGS.md §8 — full-screen confirmation. Three honest paragraphs.
 *
 * Server endpoint `POST /v1/accounts/delete` doesn't exist yet —
 * tap-Delete clears local stores and resets the user to onboarding.
 * The wire commit is a documented follow-up; without it, the user
 * remains a stranger on this device but their server-side handle
 * + keypair stay registered until the endpoint lands.
 */
export function DeleteAccountScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const userId = useIdentity((s) => s.userId);

  async function handleDelete() {
    diag('delete-account', 'commit (local-only, server endpoint TODO)', {
      userId,
    });
    // Walk the local stores and reset everything. The user lands
    // on onboarding step 1 once `userId` clears in the identity
    // store (App.tsx already routes on that flag).
    try {
      await Promise.all([
        useConversations.getState().reset(),
        useSettings.getState().reset(),
        useProfiles.getState().reset(),
        useBlocks.getState().reset(),
        useGroups.getState().reset(),
        useCalls.getState().reset?.(),
        useIdentity.getState().reset(),
      ]);
    } catch (err) {
      diag('delete-account', 'reset failure (continuing)', {
        err: String(err),
      });
    }
  }

  function confirm() {
    Alert.alert(
      'Delete this account?',
      "This can't be undone.",
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void handleDelete() },
      ],
    );
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="delete-account-screen"
    >
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Delete account</Text>
        <View style={{ width: 32 }} />
      </View>

      <View style={styles.body}>
        <View style={styles.markWrap}>
          <PeepholeMark size={56} opacity={0.6} />
        </View>
        <Text style={[styles.heading, { color: themed.ink }]}>
          Leave the room for good
          <Text style={{ color: themed.primary }}>.</Text>
        </Text>

        <Text style={[styles.copy, { color: themed.slate }]}>
          Your handle{' '}
          {userId ? (
            <Handle value={userId} variant="body" />
          ) : (
            <Text style={[styles.copyEm, { color: themed.ink }]}>—</Text>
          )}{' '}
          goes back into the pool. Anyone can claim it later.
        </Text>
        <Text style={[styles.copy, { color: themed.slate }]}>
          Conversations you're in continue without you. Your past messages stay
          where they are until they expire — Speakeasy can't reach into
          anyone's phone to delete what's already been delivered.
        </Text>
        <Text style={[styles.copy, { color: themed.slate }]}>
          You can make a new account anytime. It won't have your conversations
          or your handle.
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={onBack}
          style={[styles.btnSecondary, { borderColor: themed.divider }]}
          testID="delete-stay"
        >
          <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>Stay</Text>
        </Pressable>
        <Pressable
          onPress={confirm}
          style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
          testID="delete-confirm"
        >
          <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
            Delete
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  back: { width: 32, paddingVertical: 4 },
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  title: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
  },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 28 },
  markWrap: { alignItems: 'center', marginBottom: 20 },
  heading: {
    fontFamily: font.bold,
    fontSize: 22,
    letterSpacing: -0.02 * 22,
    textAlign: 'center',
    marginBottom: 14,
  },
  copy: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 10,
  },
  copyEm: { fontFamily: font.medium },
  actions: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: 8,
  },
  btnPrimary: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
