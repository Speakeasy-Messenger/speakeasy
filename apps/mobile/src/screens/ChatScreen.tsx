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
import { conversationIdForDirect, newMessageId } from '@speakeasy/shared';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';
import { api, getWsClient, signalProtocol, vouchflow } from '../services.js';
import { ApiError } from '../api/client.js';
import { SignalClientError } from '@speakeasy/crypto';
import { ensureSessionWithPeer } from '../crypto/session.js';
import { bytesToB64, utf8ToBytes } from '../utils/bytes.js';
import { diag } from '../diag/log.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';

interface Props {
  /** The other user's adjective-adjective-noun id, for direct chats only. */
  peerId: string;
  onBack?: () => void;
}

/**
 * 1:1 chat screen. Wires the WS client to send / receive frames, runs
 * the local TTL engine to drive each bubble through the spec §14
 * dissolve, and auto-acks incoming messages.
 *
 * # Crypto path (Phase 5b carry-over)
 *
 * Send: `ensureSessionWithPeer` → `signalProtocol.encrypt(plaintext)` →
 * base64 → wire. First send to a new peer fetches their PreKey bundle
 * from `POST /v1/prekeys/bundle` and calls `initiateSession`; subsequent
 * sends in the same process skip that step.
 *
 * Receive: base64 ciphertext from the WS frame → `signalProtocol.decrypt`
 * → utf-8 text into the bubble. The native module dispatches PreKey vs
 * Whisper messages internally based on the 1-byte type marker.
 *
 * Group / community chat is not handled here (deferred to the
 * `GroupMessagingModule` carry-over). SQLCipher message persistence
 * lands when the conversation store leaves in-memory Zustand.
 */
export function ChatScreen({ peerId, onBack }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  if (!myUserId) {
    throw new Error('ChatScreen rendered without an enrolled identity');
  }
  const conversationId = conversationIdForDirect(myUserId, peerId);
  const messages = useConversations((s) => s.byId[conversationId]?.messages ?? []);
  const ttl = useConversations((s) => s.byId[conversationId]?.ttl ?? 'week');
  const ttlSecondsFor = useConversations((s) => s.ttlSecondsFor);
  const add = useConversations((s) => s.add);
  const setStage = useConversations((s) => s.setStage);
  const remove = useConversations((s) => s.remove);
  const setTtl = useConversations((s) => s.setTtl);
  const setPersistence = useConversations((s) => s.setPersistence);
  const openDirect = useConversations((s) => s.openDirect);

  const [input, setInput] = useState('');
  const listRef = useRef<FlatList>(null);

  // Ensure the conversation entry exists with the correct peerUserId. If
  // the user navigated here via NewChatScreen this is already done; if they
  // landed via a deep link or a notification we still want the list view to
  // show this thread.
  useEffect(() => {
    openDirect(myUserId, peerId);
  }, [myUserId, peerId, openDirect]);

  // Inbound direct frames now flow through the App-level message router
  // (see App.tsx) which adds them to the conversations store and acks
  // for us. ChatScreen is a read-only view over `messages` for this
  // conversation; nothing here subscribes to the WS client directly.

  // Local TTL engine: schedule each message through its dissolve stages.
  // The actual bubble component performs the visual transitions; this
  // ticker just bumps `stage` so the component reacts.
  useEffect(() => {
    const ttlSec = ttlSecondsFor(conversationId);
    if (ttlSec === null) return; // persistence on
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const m of messages) {
      const elapsedMs = Date.now() - m.sentAt;
      const ttlMs = ttlSec * 1000;
      if (m.stage === 'sent') {
        timers.push(
          setTimeout(
            () => setStage(conversationId, m.id, 'seen'),
            Math.max(800 - elapsedMs, 0),
          ),
        );
      }
      const dissolveAt = ttlMs - elapsedMs;
      if (dissolveAt > 0 && (m.stage === 'sent' || m.stage === 'seen')) {
        timers.push(
          setTimeout(() => setStage(conversationId, m.id, 'disappearing'), dissolveAt),
          setTimeout(() => setStage(conversationId, m.id, 'almost-gone'), dissolveAt + 600),
          setTimeout(() => setStage(conversationId, m.id, 'gone'), dissolveAt + 1200),
          setTimeout(() => remove(conversationId, m.id), dissolveAt + 1600),
        );
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [messages, conversationId, ttlSecondsFor, setStage, remove]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput('');
    const id = newMessageId();
    // Optimistic local echo — we render the plaintext immediately so the
    // bubble appears with no perceived latency, then send the encrypted
    // payload over the wire in the background.
    diag('chat', 'send', { convId: conversationId, peerId, isSelf: peerId === myUserId });
    add(conversationId, {
      id,
      from: 'me',
      text: trimmed,
      kind: 'direct',
      sentAt: Date.now(),
      stage: 'sent',
    });
    void (async () => {
      try {
        let deviceToken = useIdentity.getState().deviceToken;
        if (!deviceToken) {
          diag('chat', 'send: no deviceToken, calling vouchflow.verify');
          const r = await vouchflow.verify({ context: 'login' });
          useIdentity.getState().setDeviceToken(r.deviceToken);
          deviceToken = r.deviceToken;
        }
        const isSelf = peerId === myUserId;
        let ciphertext: Uint8Array;
        if (isSelf) {
          ciphertext = utf8ToBytes(trimmed);
        } else {
          diag('chat', 'send: ensureSessionWithPeer', { peerId });
          await ensureSessionWithPeer({
            api,
            signalProtocol,
            deviceToken,
            peerUserId: peerId,
          });
          diag('chat', 'send: ensureSessionWithPeer OK', { peerId });
          ciphertext = await signalProtocol.encrypt(peerId, utf8ToBytes(trimmed));
          diag('chat', 'send: encrypt OK', { peerId, ctLen: ciphertext.length });
        }
        const ws = getWsClient(async () => deviceToken);
        await ws.waitForAuthed();
        ws.send({
          type: 'message',
          to: peerId,
          ciphertext: bytesToB64(ciphertext),
          msg_type: 'direct',
        });
        diag('chat', 'send: ws.send OK', { peerId });
      } catch (err) {
        const e = err as { name?: string; message?: string; reason?: string; code?: string; status?: number; stack?: string };
        diag('chat', 'send FAILED', {
          peerId,
          isSelf: peerId === myUserId,
          name: e.name,
          message: e.message,
          reason: e.reason,
          code: e.code,
          status: e.status,
          stack: e.stack?.slice(0, 240),
        });
        const reason =
          err instanceof SignalClientError
            ? `[encrypt failed: ${err.reason}]`
            : err instanceof ApiError
              ? `[send failed: ${err.code ?? err.status}]`
              : `[send failed: ${e.name ?? 'Error'} — ${e.message ?? String(err)}]`;
        add(conversationId, {
          id: newMessageId(),
          from: 'me',
          text: reason,
          kind: 'direct',
          sentAt: Date.now(),
          stage: 'sent',
        });
      }
    })();
  }

  function cycleTtl() {
    const order = ['hour', 'day', 'week', 'month', 'off'] as const;
    const idx = order.indexOf(ttl);
    setTtl(conversationId, order[(idx + 1) % order.length]!);
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} style={styles.back}>
            <Text style={[text.subtitle, { color: colors.primary }]}>‹ Back</Text>
          </Pressable>
        ) : null}
        <Text style={[text.heroBody, styles.peer]}>{peerId}</Text>
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
              text={item.text}
              stage={item.stage as DisappearingStage}
              variant={item.from === 'me' ? 'sent' : 'received'}
            />
          )}
          ListFooterComponent={
            <Text style={[text.footnote, styles.footnote]}>
              <View style={styles.dot} />
              {' Messages disappear after they’re seen.'}
            </Text>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />
        <View style={styles.inputBar}>
          <Pressable
            onPress={cycleTtl}
            onLongPress={() => setPersistence(conversationId, true)}
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

// -- helpers ----------------------------------------------------------------

// utf8ToBytes / bytesToB64 imported from ../utils/bytes — they're
// Hermes-safe (no Buffer dependency). The previous Buffer-based inline
// helpers crashed on first send because Hermes doesn't ship Buffer.

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
  body: { flex: 1 },
  listContent: { padding: space.md, paddingBottom: space.lg },
  footnote: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.lg,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
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
