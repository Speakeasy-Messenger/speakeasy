import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isUserId } from '@speakeasy/shared';
import { useIdentity } from '../store/identity.js';
import { api } from '../services.js';
import { ApiError } from '../api/client.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';

interface Props {
  /** Called with the validated peer id on submit. */
  onStart: (peerId: string) => void;
  onCancel: () => void;
}

/**
 * Phase 5e: minimal "start a new chat with this peer ID" screen.
 *
 * UX scope: paste a peer's three-word ID, validate, navigate to the
 * chat screen. No QR scan, no contact discovery, no friend requests —
 * those are Phase 5g items (spec §13 deferred decisions). The point of
 * this screen is to unblock 1:1 chat between two enrolled devices that
 * exchanged IDs out-of-band.
 */
export function NewChatScreen({ onStart, onCancel }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function normalize(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, '-');
  }

  // Live formatter so the user can type with spaces, hyphens, or shouty
  // caps and still end up with a `word-word-word` candidate. Lowercases,
  // converts whitespace to a dash, drops anything that isn't [a-z-],
  // collapses runs of dashes, and caps at three tokens.
  function formatInput(raw: string): string {
    const cleaned = raw
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-/, '');
    const parts = cleaned.split('-').slice(0, 3);
    return parts.join('-');
  }

  async function handleStart() {
    const candidate = normalize(input);
    if (!candidate) {
      setError('Paste a peer ID to start.');
      return;
    }
    if (!isUserId(candidate)) {
      setError('That doesn’t look like a valid Speakeasy ID. Format: word-word-word.');
      return;
    }
    // Self-DM is allowed; skip the precheck — the server already knows
    // we exist (we're enrolled).
    if (candidate === myUserId) {
      onStart(candidate);
      return;
    }
    // Precheck: ask the server whether the peer is enrolled. We do this
    // via the existing `POST /v1/prekeys/bundle` route — a 404 here is
    // exactly "no such user", and the bundle round-trip is one we'd
    // make on first send anyway, so it's not wasted work. Surfacing the
    // failure here means the user sees "user not found" before opening
    // a chat, instead of an opaque `[send failed]` halfway through.
    setBusy(true);
    setError(undefined);
    try {
      const deviceToken = useIdentity.getState().deviceToken;
      if (!deviceToken) {
        setError('Sign in again — device token missing.');
        return;
      }
      await api.fetchPreKeyBundle(deviceToken, candidate);
      onStart(candidate);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('No such user. Speakeasy IDs are case-sensitive — double-check it.');
      } else if (err instanceof ApiError) {
        setError(`Couldn’t reach that user (${err.code ?? err.status}).`);
      } else {
        setError('Network error — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView testID="new-chat-screen" style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={[text.subtitle, styles.cancel]}>‹ Back</Text>
          </Pressable>
          <Text style={[text.heroBody, styles.title]}>NEW CHAT</Text>
        </View>

        <View style={styles.content}>
          <Text style={[text.subtitle, styles.label]}>
            Enter a peer’s Speakeasy ID
          </Text>
          <Text style={[text.footnote, styles.hint]}>
            Three words, separated by hyphens. Get this from the other person — Speakeasy
            doesn’t publish a directory.
          </Text>
          <TextInput
            testID="new-chat-peer-id-input"
            style={styles.input}
            value={input}
            onChangeText={(s) => {
              setInput(formatInput(s));
              if (error) setError(undefined);
            }}
            placeholder="silent-golden-hawk"
            placeholderTextColor={colors.slate}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
            onSubmitEditing={handleStart}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        <View style={styles.bottom}>
          <Pressable
            testID="new-chat-start"
            onPress={handleStart}
            style={[styles.startBtn, busy && styles.startBtnDisabled]}
            disabled={busy}
          >
            <Text style={styles.startBtnText}>{busy ? 'Checking…' : 'Start chat'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  body: { flex: 1, padding: space.lg },
  header: { gap: space.md, marginBottom: space.xl },
  cancel: { color: colors.primary, fontFamily: fonts.inter500 },
  title: { color: colors.ink, fontFamily: fonts.inter500, letterSpacing: 1.2 },
  content: { flex: 1, gap: space.md },
  label: { color: colors.ink, fontFamily: fonts.inter500 },
  hint: { color: colors.slate },
  input: {
    minHeight: 48,
    paddingHorizontal: space.md,
    backgroundColor: colors.pale,
    borderRadius: radius.pill,
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 16,
    marginTop: space.sm,
  },
  error: {
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 12,
    marginTop: space.xs,
  },
  bottom: { gap: space.sm },
  startBtn: {
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  startBtnDisabled: { opacity: 0.6 },
  startBtnText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 16,
  },
});
