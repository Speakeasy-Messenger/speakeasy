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

  // Wire incoming messages from the WS client into the conversation store
  // and auto-ack each one. Phase 4 will tighten this with offline buffering.
  useEffect(() => {
    const ws = getWsClient(async () => (await vouchflow.verify({ context: 'login' })).deviceToken);
    const off = registerOnMessage(ws, (frame) => {
      if (frame.msg_type !== 'direct') return;
      if (frame.from !== peerId) return;
      // Decrypt off the React render path — async kick-off, push into the
      // store when complete. A failure surfaces as a red [decrypt failed]
      // bubble so the user sees the gap instead of silently dropping.
      void (async () => {
        let bodyText: string;
        try {
          const ciphertext = b64ToBytes(frame.ciphertext);
          const plaintext = await signalProtocol.decrypt(peerId, ciphertext);
          bodyText = bytesToUtf8(plaintext);
        } catch (err) {
          bodyText =
            err instanceof SignalClientError && err.reason === 'untrusted_identity'
              ? '[identity changed — verify with peer]'
              : '[decrypt failed]';
        }
        add(conversationId, {
          id: frame.message_id,
          from: peerId,
          text: bodyText,
          kind: 'direct',
          sentAt: Date.now(),
          stage: 'sent',
        });
        try {
          ws.send({ type: 'ack', message_id: frame.message_id });
        } catch {
          /* ignore — sender may not be authed yet */
        }
      })();
    });
    return off;
  }, [peerId, conversationId, add]);

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
        const verifyResult = await vouchflow.verify({ context: 'login' });
        await ensureSessionWithPeer({
          api,
          signalProtocol,
          deviceToken: verifyResult.deviceToken,
          peerUserId: peerId,
        });
        const ciphertext = await signalProtocol.encrypt(peerId, utf8ToBytes(trimmed));
        const ws = getWsClient(async () => verifyResult.deviceToken);
        ws.send({
          type: 'message',
          to: peerId,
          ciphertext: bytesToB64(ciphertext),
          msg_type: 'direct',
        });
      } catch (err) {
        // Outbound queue isn't here yet — surface failure on the bubble
        // so the user knows to retry. Same fail-mode for ApiError (peer
        // bundle fetch failed) and SignalClientError (untrusted identity,
        // encryption failure).
        const reason =
          err instanceof SignalClientError
            ? `[encrypt failed: ${err.reason}]`
            : err instanceof ApiError
              ? `[send failed: ${err.code ?? err.status}]`
              : '[send failed]';
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
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Say it…"
            placeholderTextColor={colors.slate}
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <Pressable onPress={handleSend} style={styles.send}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// -- helpers ----------------------------------------------------------------

/**
 * Subscribe to incoming `message` frames on the WS client. Returns an
 * unsubscribe function. Backs onto the client's `subscribe()` API so
 * multiple consumers (chat, prekey replenishment, future settings)
 * coexist cleanly.
 */
function registerOnMessage(
  ws: ReturnType<typeof getWsClient>,
  cb: (frame: {
    type: 'message';
    from: string;
    ciphertext: string;
    message_id: string;
    msg_type: 'direct' | 'group' | 'community';
  }) => void,
): () => void {
  return ws.subscribe((m) => {
    if ((m as { type?: string }).type === 'message') {
      cb(m as Parameters<typeof cb>[0]);
    }
  });
}

// Buffer is provided by RN's polyfill in Metro bundles + Node natively.
function utf8ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}
function bytesToUtf8(b: Uint8Array): string {
  return Buffer.from(b).toString('utf8');
}
function b64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
function bytesToB64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

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
