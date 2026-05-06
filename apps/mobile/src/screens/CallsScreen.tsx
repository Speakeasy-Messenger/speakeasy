import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isUserId } from '@speakeasy/shared';
import { Avatar } from '../components/Avatar.js';
import { PhoneIcon } from '../components/icons/CallIcons.js';
import { useCalls } from '../store/calls.js';
import { useIdentity } from '../store/identity.js';
import { colors, fonts, radius, space, text, useColors } from '../theme/index.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import type { CallEndedReason } from '../calls/types.js';

interface Props {
  orchestrator?: CallOrchestrator;
  onCallStarted: () => void;
}

/**
 * Calls tab — primary entry point for voice calling. Combines the
 * dial-by-handle affordance with local call history below it.
 *
 * If `orchestrator` is undefined (e.g. the user hasn't enrolled yet,
 * or the orchestrator failed to construct), the dial UI is disabled
 * with a clear message instead of throwing.
 */
export function CallsScreen({ orchestrator, onCallStarted }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  const history = useCalls((s) => s.history);
  const themed = useColors();
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

  async function handleCall(handle?: string): Promise<void> {
    if (!orchestrator) {
      setError('Calling is unavailable right now.');
      return;
    }
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
      setInput('');
      onCallStarted();
    } catch (err) {
      setError(`Couldn't start call: ${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="calls-screen"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <View style={styles.header}>
          <Text style={[text.sectionLabel, styles.label, { color: themed.slate }]}>
            CALLS
          </Text>
          <Text style={[text.heroBody, styles.title, { color: themed.ink }]}>
            Dial a handle
          </Text>
        </View>

        <View style={[styles.inputRow, { backgroundColor: themed.pale }]}>
          <Text style={[styles.atPrefix, { color: themed.slate }]}>@</Text>
          <TextInput
            testID="calls-dial-input"
            style={[styles.input, { color: themed.ink }]}
            value={input}
            onChangeText={(raw) => {
              setInput(formatInput(raw));
              setError(undefined);
            }}
            placeholder="velvet-dark-river"
            placeholderTextColor={themed.slate}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void handleCall()}
            returnKeyType="done"
            editable={!!orchestrator && !busy}
          />
          <Pressable
            testID="calls-dial-btn"
            disabled={busy || !orchestrator}
            onPress={() => void handleCall()}
            style={[
              styles.dialBtn,
              {
                backgroundColor: themed.primary,
                opacity: busy || !orchestrator ? 0.5 : 1,
              },
            ]}
          >
            <PhoneIcon size={20} color={themed.cream} />
          </Pressable>
        </View>
        {error ? (
          <Text style={[text.subtitle, styles.error]}>{error}</Text>
        ) : null}

        <Text
          style={[text.sectionLabel, styles.historyLabel, { color: themed.slate }]}
        >
          RECENT
        </Text>

        <ScrollView style={styles.historyList} contentContainerStyle={styles.historyContent}>
          {history.length === 0 ? (
            <Text style={[text.subtitle, styles.empty, { color: themed.slate }]}>
              No call history yet.
            </Text>
          ) : (
            history.map((entry) => (
              <Pressable
                key={entry.callId}
                onPress={() => void handleCall(entry.peerUserId)}
                style={[styles.historyRow, { backgroundColor: themed.pale }]}
                testID={`calls-history-${entry.callId}`}
              >
                <Avatar userId={entry.peerUserId} size={36} />
                <View style={styles.historyBody}>
                  <Text
                    style={[styles.historyPeer, { color: themed.ink }]}
                    numberOfLines={1}
                  >
                    @{entry.peerUserId}
                  </Text>
                  <Text style={[styles.historyMeta, { color: themed.slate }]}>
                    {entry.isCaller ? 'Outgoing' : 'Incoming'} ·{' '}
                    {labelForReason(entry.reason)}
                    {entry.durationSec > 0
                      ? ` · ${formatDuration(entry.durationSec)}`
                      : ''}
                  </Text>
                </View>
                <Text style={[styles.historyTime, { color: themed.slate }]}>
                  {relativeTime(entry.endedAt)}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function labelForReason(reason: CallEndedReason): string {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'no_answer':
      return 'no answer';
    case 'callee_offline':
      return 'unreachable';
    case 'busy':
      return 'busy';
    case 'decline':
      return 'declined';
    case 'cancel':
      return 'cancelled';
    case 'hangup':
      return 'ended';
    case 'failed':
      return 'failed';
    default:
      return reason;
  }
}

function formatDuration(sec: number): string {
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  body: { flex: 1, padding: space.lg, gap: space.md },
  header: { gap: 4 },
  label: { letterSpacing: 2 },
  title: { fontFamily: fonts.inter500 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.pale,
    borderRadius: radius.pill,
    paddingLeft: space.md,
    paddingRight: 4,
    gap: 4,
  },
  atPrefix: {
    color: colors.slate,
    fontFamily: fonts.inter500,
    fontSize: 16,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 16,
  },
  dialBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { color: '#D63E3E' },
  historyLabel: { letterSpacing: 2, marginTop: space.sm },
  historyList: { flex: 1 },
  historyContent: { gap: space.xs, paddingBottom: space.lg },
  empty: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.xl,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.pale,
    borderRadius: radius.avatar,
  },
  historyBody: { flex: 1, gap: 2 },
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
  historyTime: {
    color: colors.slate,
    fontFamily: fonts.inter300,
    fontSize: 11,
  },
});
