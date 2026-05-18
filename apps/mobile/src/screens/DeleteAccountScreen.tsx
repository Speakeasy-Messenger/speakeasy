import React from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppBar } from '../components/AppBar.js';
import { Handle } from '../components/Handle.js';
import { PeepholeMark } from '../components/PeepholeMark.js';
import notifee from '@notifee/react-native';
import { useBlocks } from '../store/blocks.js';
import { useCalls } from '../store/calls.js';
import { useConversations } from '../store/conversations.js';
import { useDistributionIds } from '../store/distribution-ids.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useOnboardingCards } from '../store/onboarding-cards.js';
import { useOwnership } from '../store/ownership.js';
import { useProfiles } from '../store/profiles.js';
import { useSettings } from '../store/settings.js';
import { wipeAllPersistedState } from '../store/wipe.js';
import { clearAvatarCache } from '../push/avatar-cache.js';
import { api, signalProtocol } from '../services.js';
import { useColors } from '../theme/index.js';
import { font, space } from '../theme/tokens.js';
import { diag } from '../diag/log.js';

interface Props {
  onBack: () => void;
}

/**
 * SETTINGS.md §8 — full-screen confirmation. Three honest paragraphs.
 *
 * Delete is a true clean slate: the account is deleted server-side
 * (`DELETE /v1/users/me` — frees the handle), the native SQLCipher
 * Signal store is wiped, the avatar cache + notifications are cleared,
 * and every persisted store is dropped. Then `userId` clears and the
 * navigator routes to Onboarding.
 */
export function DeleteAccountScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const userId = useIdentity((s) => s.userId);

  async function handleDelete() {
    const deviceToken = useIdentity.getState().deviceToken;
    diag('delete-account', 'commit', { userId, hasToken: !!deviceToken });

    // 1. Server-side delete — best-effort. A network failure must not
    //    trap the user on this screen; the local wipe runs regardless.
    if (deviceToken) {
      try {
        await api.deleteAccount(deviceToken);
        diag('delete-account', 'server delete OK');
      } catch (err) {
        diag('delete-account', 'server delete failed (continuing wipe)', {
          err: String(err),
        });
      }
    }

    // 2. Native Signal store — delete the SQLCipher DB so a re-onboard
    //    can't resurrect this identity's keys, sessions, or caches.
    try {
      await signalProtocol.wipeStore();
    } catch (err) {
      diag('delete-account', 'wipeStore failed (continuing)', { err: String(err) });
    }

    // 3. Notification avatar cache + any notifications still showing.
    await clearAvatarCache();
    try {
      await notifee.cancelAllNotifications();
    } catch {
      /* best-effort */
    }

    // 4. In-memory store state — reset everything so the live session
    //    shows no ghost data.
    try {
      await Promise.all([
        useConversations.getState().reset(),
        useSettings.getState().reset(),
        useProfiles.getState().reset(),
        useBlocks.getState().reset(),
        useGroups.getState().reset(),
        useCalls.getState().reset?.(),
        useDistributionIds.getState().reset(),
        useOnboardingCards.getState().reset(),
        useOwnership.getState().reset(),
      ]);
    } catch (err) {
      diag('delete-account', 'store reset failure (continuing)', {
        err: String(err),
      });
    }

    // 5. Every persisted `speakeasy.*` AsyncStorage key — catches any
    //    store without a reset() and the push tap-target slot.
    await wipeAllPersistedState();

    // 6. Identity last — clearing `userId` routes App.tsx to Onboarding.
    await useIdentity.getState().reset();
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
      <AppBar onBack={onBack} title="Delete account" testID="delete-account-appbar" />

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
  body: { flex: 1, paddingHorizontal: space.xl, paddingTop: space.xxl },
  markWrap: { alignItems: 'center', marginBottom: 20 },
  heading: {
    fontFamily: font.bold,
    fontSize: 22,
    letterSpacing: -0.02 * 22,
    textAlign: 'center',
    marginBottom: space.base,
  },
  copy: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: space.m,
  },
  copyEm: { fontFamily: font.medium },
  actions: {
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
    gap: space.s,
  },
  btnPrimary: {
    paddingVertical: space.base,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    paddingVertical: space.base,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
