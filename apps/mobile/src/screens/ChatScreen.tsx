import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  conversationIdForDirect,
  encodePayload,
  newMessageId,
  type Attachment,
} from '@speakeasy/shared';
import { pickFile, pickFromCamera, pickPhotos } from '../attachments/pick.js';
import { saveAndAnnounceFile } from '../attachments/save-and-open.js';
import { GifPickerSheet } from '../components/GifPickerSheet.js';
import { CameraIcon, GifIcon, PaperclipIcon } from '../components/icons/InputBarIcons.js';
import { PhoneIcon } from '../components/icons/CallIcons.js';
import { MediaViewerScreen } from './MediaViewerScreen.js';
import { Avatar } from '../components/Avatar.js';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { useConversations, type ChatMessage } from '../store/conversations.js';
import { useUiState } from '../store/ui.js';
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
  /**
   * Optional: tap-handler for the phone-icon affordance in the chat
   * header. When provided, the icon is rendered. When omitted (e.g. a
   * test rendering ChatScreen in isolation), the call entry point is
   * hidden.
   */
  onStartCall?: (peerId: string) => void;
}

// Stable fallback for the messages selector. A fresh `[]` literal in the
// selector would make the useSyncExternalStore snapshot non-idempotent
// and trip "Maximum update depth exceeded" — see GroupChatScreen for the
// reproducer that motivated this. ChatScreen happens to always have a
// conversations entry created via `openDirect` before navigation, but
// the stable fallback keeps the snapshot safe regardless of caller order.
const EMPTY_MESSAGES: ChatMessage[] = [];

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
export function ChatScreen({ peerId, onBack, onStartCall }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  if (!myUserId) {
    throw new Error('ChatScreen rendered without an enrolled identity');
  }
  const conversationId = conversationIdForDirect(myUserId, peerId);
  const messages = useConversations((s) => s.byId[conversationId]?.messages ?? EMPTY_MESSAGES);
  const ttl = useConversations((s) => s.byId[conversationId]?.ttl ?? 'week');
  const ttlSecondsFor = useConversations((s) => s.ttlSecondsFor);
  const add = useConversations((s) => s.add);
  const setStage = useConversations((s) => s.setStage);
  const remove = useConversations((s) => s.remove);
  const setTtl = useConversations((s) => s.setTtl);
  const setPersistence = useConversations((s) => s.setPersistence);
  const openDirect = useConversations((s) => s.openDirect);
  const markRead = useConversations((s) => s.markRead);

  const [input, setInput] = useState('');
  // Tap a photo/gif in the bubble → render this attachment fullscreen
  // in a Modal layered over the chat. Null = closed.
  const [viewerAttachment, setViewerAttachment] = useState<Attachment | null>(null);
  const [gifSheetOpen, setGifSheetOpen] = useState(false);
  const listRef = useRef<FlatList>(null);

  // Ensure the conversation entry exists with the correct peerUserId. If
  // the user navigated here via NewChatScreen this is already done; if they
  // landed via a deep link or a notification we still want the list view to
  // show this thread.
  useEffect(() => {
    openDirect(myUserId, peerId);
  }, [myUserId, peerId, openDirect]);

  // Mark read on open AND every time a new inbound message lands while
  // the screen is mounted — being on the chat means the user has seen
  // whatever just arrived, so the list-screen unread badge should stay
  // at 0 instead of bumping to 1+ on each delivery.
  useEffect(() => {
    markRead(conversationId);
  }, [conversationId, markRead, messages.length]);

  // Track the active conversation so the in-app message banner can
  // suppress itself when the user is already staring at this chat.
  useEffect(() => {
    useUiState.getState().setActiveConversation(conversationId);
    return () => useUiState.getState().setActiveConversation(undefined);
  }, [conversationId]);

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
    void sendOutbound({ text: trimmed });
  }

  // WhatsApp-style direct affordances — no nested action sheet.
  // Paperclip is the only one that branches (Photos vs Files), since
  // those two pickers are functionally distinct on Android.
  async function handlePaperclip() {
    Alert.alert('Attach', 'Pick a source.', [
      {
        text: 'Photos',
        onPress: async () => {
          const photos = await pickPhotos();
          if (photos.length) await sendOutbound({ attachments: photos });
        },
      },
      {
        text: 'File',
        onPress: async () => {
          const file = await pickFile();
          if (file) await sendOutbound({ attachments: [file] });
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function handleCamera() {
    const photo = await pickFromCamera();
    if (photo) await sendOutbound({ attachments: [photo] });
  }

  function handleGif() {
    setGifSheetOpen(true);
  }

  async function handleGifPicked(gif: Attachment) {
    setGifSheetOpen(false);
    await sendOutbound({ attachments: [gif] });
  }

  async function sendOutbound(opts: { text?: string; attachments?: Attachment[] }) {
    const text = opts.text?.trim() || undefined;
    const attachments = opts.attachments?.length ? opts.attachments : undefined;
    if (!text && !attachments) return;
    const id = newMessageId();
    // Optimistic local echo — render immediately, encrypt + send
    // in the background.
    diag('chat', 'send', {
      convId: conversationId,
      peerId,
      isSelf: peerId === myUserId,
      hasAttachments: !!attachments,
      attachCount: attachments?.length ?? 0,
    });
    add(conversationId, {
      id,
      from: 'me',
      text: text ?? '',
      attachments,
      kind: 'direct',
      sentAt: Date.now(),
      stage: 'sent',
      // Single ✓ until the server's `delivered` WS frame flips this
      // to true (then the bubble renders ✓✓). Failed sends below
      // omit `delivered` entirely — error bubbles don't show a glyph.
      delivered: false,
    });
    try {
      let deviceToken = useIdentity.getState().deviceToken;
      if (!deviceToken) {
        diag('chat', 'send: no deviceToken, calling vouchflow.verify');
        const r = await vouchflow.verify({ context: 'login' });
        useIdentity.getState().setDeviceToken(r.deviceToken);
        deviceToken = r.deviceToken;
      }
      const isSelf = peerId === myUserId;
      // Pack the text + attachments into the v1 envelope. Pre-rebrand
      // peers see legacy raw utf-8 text — `decodePayload` handles both.
      const plaintext = encodePayload({ v: 1, text, attachments });
      let ciphertext: Uint8Array;
      if (isSelf) {
        ciphertext = utf8ToBytes(plaintext);
      } else {
        diag('chat', 'send: ensureSessionWithPeer', { peerId });
        await ensureSessionWithPeer({
          api,
          signalProtocol,
          deviceToken,
          peerUserId: peerId,
        });
        diag('chat', 'send: ensureSessionWithPeer OK', { peerId });
        ciphertext = await signalProtocol.encrypt(peerId, utf8ToBytes(plaintext));
        diag('chat', 'send: encrypt OK', { peerId, ctLen: ciphertext.length });
      }
      const ws = getWsClient(async () => deviceToken);
      await ws.waitForAuthed();
      // Re-confirm the state right before send — `ensureSessionWithPeer`
      // above can take ~10s, plenty of time for a WS flap.
      if (ws.getState() !== 'authed') await ws.waitForAuthed();
      ws.send({
        type: 'message',
        to: peerId,
        ciphertext: bytesToB64(ciphertext),
        msg_type: 'direct',
      });
      diag('chat', 'send: ws.send OK', { peerId });
    } catch (err: unknown) {
      const e = err as {
        name?: string;
        message?: string;
        reason?: string;
        code?: string;
        status?: number;
        stack?: string;
      };
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
  }

  function cycleTtl() {
    const order = ['hour', 'day', 'week', 'month', 'off'] as const;
    const idx = order.indexOf(ttl);
    setTtl(conversationId, order[(idx + 1) % order.length]!);
  }

  return (
    <SafeAreaView testID="chat-screen" style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {onBack ? (
            <Pressable testID="chat-back" onPress={onBack} style={styles.back}>
              <Text style={[text.subtitle, { color: colors.primary }]}>‹ Back</Text>
            </Pressable>
          ) : (
            <View style={styles.back} />
          )}
          <View style={styles.headerCenter}>
            <Avatar userId={peerId} size={32} />
            <Text style={[text.heroBody, styles.peer]}>@{peerId}</Text>
          </View>
          {onStartCall ? (
            <Pressable
              testID="chat-call"
              onPress={() => onStartCall(peerId)}
              hitSlop={8}
              style={styles.callBtn}
            >
              <PhoneIcon size={22} color={colors.primary} />
            </Pressable>
          ) : (
            <View style={styles.callBtn} />
          )}
        </View>
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
              attachments={item.attachments}
              stage={item.stage as DisappearingStage}
              variant={item.from === 'me' ? 'sent' : 'received'}
              delivered={item.delivered}
              onTapPhoto={(a) => setViewerAttachment(a)}
              onTapFile={(a) => void saveAndAnnounceFile(a)}
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
        <View style={styles.composer}>
          <Pressable
            onPress={cycleTtl}
            onLongPress={() => setPersistence(conversationId, true)}
            style={styles.ttlPill}
          >
            <Text style={styles.ttlText}>⏱ {ttl}</Text>
          </Pressable>
          <View style={styles.inputBar}>
            <Pressable
              onPress={handleGif}
              hitSlop={6}
              style={styles.iconBtn}
              testID="chat-gif"
            >
              <GifIcon size={22} />
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
            <Pressable
              onPress={handlePaperclip}
              hitSlop={6}
              style={styles.iconBtn}
              testID="chat-attach"
            >
              <PaperclipIcon size={22} />
            </Pressable>
            <Pressable
              onPress={handleCamera}
              hitSlop={6}
              style={styles.iconBtn}
              testID="chat-camera"
            >
              <CameraIcon size={22} />
            </Pressable>
            <Pressable testID="chat-send" onPress={handleSend} style={styles.send}>
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      <Modal
        visible={!!viewerAttachment}
        animationType="fade"
        onRequestClose={() => setViewerAttachment(null)}
      >
        {viewerAttachment ? (
          <MediaViewerScreen
            data={viewerAttachment.data}
            mime={viewerAttachment.mime}
            onClose={() => setViewerAttachment(null)}
          />
        ) : null}
      </Modal>
      <GifPickerSheet
        visible={gifSheetOpen}
        onClose={() => setGifSheetOpen(false)}
        onPick={(gif) => void handleGifPicked(gif)}
      />
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
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flex: 1,
    paddingHorizontal: space.sm,
  },
  back: { paddingVertical: 4, minWidth: 56 },
  callBtn: { padding: 6, minWidth: 44, alignItems: 'flex-end' },
  peer: { color: colors.ink, fontFamily: fonts.inter500 },
  body: { flex: 1 },
  listContent: { padding: space.md, paddingBottom: space.lg },
  footnote: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.lg,
  },
  // Spec §6.10: status indicator is a 6×6 brass square — no radius.
  dot: { width: 6, height: 6, backgroundColor: colors.primary },
  composer: {
    borderTopColor: colors.pale,
    borderTopWidth: 1,
    backgroundColor: colors.cream,
    paddingVertical: 6,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ttlPill: {
    alignSelf: 'flex-start',
    marginLeft: space.md,
    marginBottom: 2,
    paddingVertical: 4,
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
