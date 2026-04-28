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

  function normalize(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, '-');
  }

  function handleStart() {
    const candidate = normalize(input);
    if (!candidate) {
      setError('Paste a peer ID to start.');
      return;
    }
    if (!isUserId(candidate)) {
      setError('That doesn’t look like a valid Speakeasy ID. Format: word-word-word.');
      return;
    }
    if (candidate === myUserId) {
      setError('You can’t message yourself. Yet.');
      return;
    }
    onStart(candidate);
  }

  return (
    <SafeAreaView style={styles.root}>
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
            style={styles.input}
            value={input}
            onChangeText={(s) => {
              setInput(s);
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
          <Pressable onPress={handleStart} style={styles.startBtn}>
            <Text style={styles.startBtnText}>Start chat</Text>
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
  startBtnText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 16,
  },
});
