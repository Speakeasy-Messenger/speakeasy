import React, { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { newMessageId } from '@speakeasy/shared';
import { SignalClientError } from '@speakeasy/crypto';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { useConversations, type ChatMessage } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useDistributionIds } from '../store/distribution-ids.js';
import { useIdentity } from '../store/identity.js';
import { api, getWsClient, groupMessaging, signalProtocol, vouchflow } from '../services.js';
import { ApiError } from '../api/client.js';
import { makeGroupOrchestrator } from '../crypto/group-orchestration.js';
import { utf8ToBytes } from '../utils/bytes.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';

interface Props {
  groupId: string;
  onBack?: () => void;
}

// Stable fallback for the messages selector. A fresh `[]` literal here
// would make the useSyncExternalStore snapshot non-idempotent and trip
// React's "Maximum update depth exceeded" loop the first time you open
// a group you created but haven't messaged in yet (no conversations-store
// entry exists for it, so the `?? []` branch fires).
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Group chat screen — Phase 5e.
 *
 * Read path: messages live in `useConversations.byId[groupId]`. The App-
 * level message router buckets inbound `group` frames there directly, so
 * this screen is a read-only view + a send button.
 *
 * Send path: bumps the local optimistic bubble onto the conversation
 * store, then calls `groupOrchestrator.sendGroupMessage` which:
 *   1. Bootstraps SKDMs for any members we haven't sent to in this
 *      process (one 1:1 Signal envelope per peer per cold start).
 *   2. Encrypts the plaintext with `groupMessaging.encryptForGroup`.
 *   3. Emits the WS `message` frame with `msg_type='group'`.
 *
 * The orchestrator is constructed per-render (cheap; bootstrap state is
 * a captured Map). All other deps come from singleton services.
 */
export function GroupChatScreen({ groupId, onBack }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  if (!myUserId) {
    throw new Error('GroupChatScreen rendered without an enrolled identity');
  }
  const group = useGroups((s) => s.byId[groupId]);
  const messages = useConversations((s) => s.byId[groupId]?.messages ?? EMPTY_MESSAGES);
  const ttl = useConversations((s) => s.byId[groupId]?.ttl ?? 'week');
  const ttlSecondsFor = useConversations((s) => s.ttlSecondsFor);
  const add = useConversations((s) => s.add);
  const setStage = useConversations((s) => s.setStage);
  const remove = useConversations((s) => s.remove);
  const setTtl = useConversations((s) => s.setTtl);
  const setPersistence = useConversations((s) => s.setPersistence);
  const markRead = useConversations((s) => s.markRead);
  const openGroup = useConversations((s) => s.openGroup);

  // Ensure the conversations-store entry exists *before* markRead, which
  // is a no-op when `byId[groupId]` is undefined. Without this, opening a
  // freshly-created group (no messages yet) would never clear its unread
  // state.
  useEffect(() => {
    openGroup(groupId);
    markRead(groupId);
  }, [groupId, openGroup, markRead]);

  const [input, setInput] = useState('');
  const listRef = useRef<FlatList>(null);

  // Local TTL engine — same as ChatScreen.
  useEffect(() => {
    const ttlSec = ttlSecondsFor(groupId);
    if (ttlSec === null) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const m of messages) {
      const elapsedMs = Date.now() - m.sentAt;
      const ttlMs = ttlSec * 1000;
      if (m.stage === 'sent') {
        timers.push(
          setTimeout(
            () => setStage(groupId, m.id, 'seen'),
            Math.max(800 - elapsedMs, 0),
          ),
        );
      }
      const dissolveAt = ttlMs - elapsedMs;
      if (dissolveAt > 0 && (m.stage === 'sent' || m.stage === 'seen')) {
        timers.push(
          setTimeout(() => setStage(groupId, m.id, 'disappearing'), dissolveAt),
          setTimeout(() => setStage(groupId, m.id, 'almost-gone'), dissolveAt + 600),
          setTimeout(() => setStage(groupId, m.id, 'gone'), dissolveAt + 1200),
          setTimeout(() => remove(groupId, m.id), dissolveAt + 1600),
        );
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [messages, groupId, ttlSecondsFor, setStage, remove]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (!group) {
      // Defensive: somehow on this screen for an unknown group. Surface
      // it on a bubble so the user notices.
      add(groupId, {
        id: newMessageId(),
        from: 'me',
        text: '[group not loaded — go back and retry]',
        kind: 'group',
        sentAt: Date.now(),
        stage: 'sent',
      });
      return;
    }
    setInput('');
    const localId = newMessageId();
    // Optimistic local echo.
    add(groupId, {
      id: localId,
      from: 'me',
      text: trimmed,
      kind: 'group',
      sentAt: Date.now(),
      stage: 'sent',
    });
    void (async () => {
      try {
        const getDeviceToken = async () => {
          const cached = useIdentity.getState().deviceToken;
          if (cached) return cached;
          const r = await vouchflow.verify({ context: 'login' });
          useIdentity.getState().setDeviceToken(r.deviceToken);
          return r.deviceToken;
        };
        const ws = getWsClient(getDeviceToken);
        const orchestrator = makeGroupOrchestrator({
          api,
          signalProtocol,
          groupMessaging,
          ws,
          getDeviceToken,
          getOrCreateDistributionId: (id) =>
            useDistributionIds.getState().getOrCreate(id),
        });
        await ws.waitForAuthed();
        await orchestrator.sendGroupMessage({
          groupId,
          members: group.members,
          selfUserId: myUserId!,
          plaintext: utf8ToBytes(trimmed),
        });
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        const reason =
          err instanceof SignalClientError
            ? `[encrypt failed: ${err.reason}]`
            : err instanceof ApiError
              ? `[send failed: ${err.code ?? err.status}]`
              : `[send failed: ${e.name ?? 'Error'} — ${e.message ?? String(err)}]`;
        add(groupId, {
          id: newMessageId(),
          from: 'me',
          text: reason,
          kind: 'group',
          sentAt: Date.now(),
          stage: 'sent',
        });
      }
    })();
  }

  function cycleTtl() {
    const order = ['hour', 'day', 'week', 'month', 'off'] as const;
    const idx = order.indexOf(ttl);
    setTtl(groupId, order[(idx + 1) % order.length]!);
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable testID="group-chat-back" onPress={onBack} style={styles.back}>
            <Text style={[text.subtitle, { color: colors.primary }]}>‹ Back</Text>
          </Pressable>
        ) : null}
        <Text style={[text.heroBody, styles.peer]}>
          # {group?.name ?? groupId}
        </Text>
        <Text style={[text.footnote, styles.subhead]}>
          {group ? `${group.members.length} member${group.members.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <DisappearingMessageBubble
              text={
                item.from === 'me'
                  ? item.text
                  : `${item.from}: ${item.text}`
              }
              stage={item.stage as DisappearingStage}
              variant={item.from === 'me' ? 'sent' : 'received'}
            />
          )}
          ListFooterComponent={
            <Text style={[text.footnote, styles.footnote]}>
              {'Messages disappear after they’re seen.'}
            </Text>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />
        <View style={styles.inputBar}>
          <Pressable
            onPress={cycleTtl}
            onLongPress={() => setPersistence(groupId, true)}
            style={styles.ttlPill}
          >
            <Text style={styles.ttlText}>⏱ {ttl}</Text>
          </Pressable>
          <TextInput
            testID="chat-input"
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Say it…"
            placeholderTextColor={colors.slate}
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <Pressable testID="chat-send" onPress={handleSend} style={styles.send}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// utf8ToBytes imported from ../utils/bytes — Hermes-safe.

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomColor: colors.pale,
    borderBottomWidth: 1,
    gap: space.xs,
  },
  back: { paddingVertical: 4 },
  peer: { color: colors.ink, fontFamily: fonts.inter500 },
  subhead: { color: colors.slate },
  body: { flex: 1 },
  listContent: { padding: space.md, paddingBottom: space.lg },
  footnote: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.lg,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopColor: colors.pale,
    borderTopWidth: 1,
    backgroundColor: colors.cream,
  },
  ttlPill: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.pale,
  },
  ttlText: {
    fontFamily: fonts.inter500,
    fontSize: 11,
    color: colors.primary,
    letterSpacing: 0.4,
  },
  input: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: space.md,
    backgroundColor: colors.pale,
    borderRadius: radius.pill,
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 15,
  },
  send: {
    paddingVertical: 10,
    paddingHorizontal: space.md,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  },
  sendText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 14,
  },
});
