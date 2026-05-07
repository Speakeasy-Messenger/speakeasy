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
import { useCalls } from '../store/calls.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { callPalette } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  onCallStarted: () => void;
  onCancel: () => void;
}

/**
 * Phase 6: dial-by-handle screen. Mirrors NewChatScreen's input affordance
 * but invokes `orchestrator.startOutgoing` instead of opening a chat.
 *
 * Also surfaces the recent local call history below the input — this is
 * the "let me debug things" affordance the user asked for. Tapping a row
 * redials that handle.
 */
export function DialerScreen({ orchestrator, onCallStarted, onCancel }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  const history = useCalls((s) => s.history);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function normalize(s: string): string {
    return s.trim().replace(/^@/, '').toLowerCase();
  }

  function formatInput(raw: string): string {
    return raw
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40);
  }

  async function handleCall(handle?: string) {
    const candidate = handle ?? normalize(input);
    if (!candidate) {
      setError('Enter a handle.');
      return;
    }
    if (!isUserId(candidate) && !/^[a-z][a-z0-9_]{2,19}$/.test(candidate)) {
      setError('Handles look like @yourname or velvet-dark-river.');
      return;
    }
    if (candidate === myUserId) {
      setError("You can't call yourself.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await orchestrator.startOutgoing(candidate);
      onCallStarted();
    } catch (err) {
      setError(`Couldn't start call: ${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.root} testID="dialer-screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <View style={styles.header}>
          <Pressable onPress={onCancel} testID="dialer-cancel">
            <Text style={[text.subtitle, { color: colors.primary }]}>‹ Back</Text>
          </Pressable>
          <Text style={[text.sectionLabel, styles.title]}>NEW CALL</Text>
          <View style={{ width: 44 }} />
        </View>

        <Text style={[text.subtitle, styles.helpText]}>
          Enter the handle of the person you want to call.
        </Text>
        <View style={styles.inputRow}>
          <Text style={styles.atPrefix}>@</Text>
          <TextInput
            testID="dialer-input"
            style={styles.input}
            value={input}
            onChangeText={(raw) => {
              setInput(formatInput(raw));
              setError(undefined);
            }}
            placeholder="velvet-dark-river"
            placeholderTextColor={colors.slate}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void handleCall()}
            returnKeyType="done"
          />
        </View>
        {error ? <Text style={[text.subtitle, styles.error]}>{error}</Text> : null}

        <Pressable
          testID="dialer-call-btn"
          disabled={busy}
          onPress={() => void handleCall()}
          style={[styles.callBtn, busy && { opacity: 0.6 }]}
        >
          <Text style={styles.callBtnText}>{busy ? 'Starting…' : 'Call'}</Text>
        </Pressable>

        {history.length > 0 ? (
          <View style={styles.historyBlock}>
            <Text style={[text.sectionLabel, styles.historyLabel]}>RECENT CALLS</Text>
            {history.slice(0, 8).map((entry) => (
              <Pressable
                key={entry.callId}
                onPress={() => void handleCall(entry.peerUserId)}
                style={styles.historyRow}
                testID={`dialer-history-${entry.callId}`}
              >
                <Text style={styles.historyPeer}>@{entry.peerUserId}</Text>
                <Text style={styles.historyMeta}>
                  {entry.isCaller ? '↗' : '↙'} {entry.reason}
                  {entry.durationSec > 0 ? ` · ${formatDuration(entry.durationSec)}` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function formatDuration(sec: number): string {
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  body: { flex: 1, padding: space.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: space.md,
  },
  title: { color: colors.slate, letterSpacing: 2 },
  helpText: { color: colors.slate, marginBottom: space.md },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.pale,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
  },
  atPrefix: {
    color: colors.slate,
    fontFamily: fonts.inter500,
    fontSize: 16,
    marginRight: 4,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 16,
  },
  error: { color: callPalette.decline, marginTop: space.sm },
  callBtn: {
    marginTop: space.lg,
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  callBtnText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 15,
  },
  historyBlock: { marginTop: space.xl, gap: space.xs },
  historyLabel: {
    color: colors.slate,
    letterSpacing: 2,
    marginBottom: space.sm,
  },
  historyRow: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.pale,
    borderRadius: radius.avatar,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyPeer: {
    color: colors.ink,
    fontFamily: fonts.inter500,
    fontSize: 14,
  },
  historyMeta: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 12,
  },
});
