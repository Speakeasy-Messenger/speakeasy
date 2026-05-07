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
import Svg, { Path } from 'react-native-svg';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { useConversations, type ChatMessage } from '../store/conversations.js';
import { useUiState } from '../store/ui.js';
import { useIdentity } from '../store/identity.js';
import { api, getWsClient, signalProtocol, vouchflow } from '../services.js';
import { ApiError } from '../api/client.js';
import { SignalClientError } from '@speakeasy/crypto';
import { ensureSessionWithPeer, clearSessionCacheFor } from '../crypto/session.js';
import { bytesToB64, utf8ToBytes } from '../utils/bytes.js';
import { diag } from '../diag/log.js';
import { colors, fonts, space } from '../theme/index.js';
import { font, type } from '../theme/tokens.js';
import { useColors } from '../theme/index.js';

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
  const themed = useColors();
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
      // Identity-key change recovery: same flow as the dialer (see
      // DialerScreen.handleCall). Surface the new-identity prompt
      // instead of stamping a "[encrypt failed: untrusted_identity]"
      // error bubble, since the user can almost always recover by
      // opting in to trust the rotated key.
      if (err instanceof SignalClientError && err.reason === 'untrusted_identity') {
        Alert.alert(
          `@${peerId}'s identity has changed`,
          `This usually means they reinstalled the app. It could also indicate a security issue. Trust the new identity and resend?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Trust + send',
              style: 'destructive',
              onPress: () => void resendAfterReset(opts),
            },
          ],
        );
        return;
      }
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

  async function resendAfterReset(opts: { text?: string; attachments?: Attachment[] }) {
    try {
      await signalProtocol.resetPeer(peerId);
      clearSessionCacheFor(peerId);
      // Re-enter the normal send path. The optimistic echo for the
      // FIRST attempt is still on screen; rather than de-dupe by id,
      // we just send a fresh message — the user just opted to retry.
      await sendOutbound(opts);
    } catch (err) {
      diag('chat', 'resend after reset FAILED', { err: String(err) });
      add(conversationId, {
        id: newMessageId(),
        from: 'me',
        text: `[reset failed: ${(err as Error).message ?? String(err)}]`,
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

  const hasInput = input.trim().length > 0;
  // Brand §6.1: handle in `text` weight 500, segments joined by `accent`
  // `·` separators. Speakeasy ids are noun-noun-noun on the wire — split
  // and re-join with the brass dot for the AppBar treatment. Other
  // surfaces (list, composer placeholder) keep `@handle` for familiarity.
  const handleSegments = peerId.split('-').filter(Boolean);

  return (
    <SafeAreaView testID="chat-screen" style={[styles.root, { backgroundColor: themed.cream }]}>
      <View style={[styles.header, { borderBottomColor: themed.divider }]}>
        {onBack ? (
          <Pressable testID="chat-back" onPress={onBack} hitSlop={8} style={styles.back}>
            <Text style={[styles.backText, { color: themed.primary }]}>‹</Text>
          </Pressable>
        ) : (
          <View style={styles.back} />
        )}
        <View style={styles.headerHandle}>
          <Text style={[styles.handleText, { color: themed.ink }]} numberOfLines={1}>
            {handleSegments.map((seg, i) => (
              <React.Fragment key={i}>
                {i > 0 ? (
                  <Text style={{ color: themed.primary }}> · </Text>
                ) : null}
                {seg}
              </React.Fragment>
            ))}
          </Text>
        </View>
        {onStartCall ? (
          <Pressable
            testID="chat-call"
            onPress={() => onStartCall(peerId)}
            hitSlop={8}
            style={styles.callBtn}
          >
            <PhoneIcon size={22} color={themed.primary} />
          </Pressable>
        ) : (
          <View style={styles.callBtn} />
        )}
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
            <View style={styles.footnote}>
              <View style={[styles.dot, { backgroundColor: themed.primary }]} />
              <Text style={[styles.footnoteText, { color: themed.slate }]}>
                MESSAGES DISAPPEAR AFTER THEY'RE SEEN
              </Text>
            </View>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />
        {/* Brand §6.5 InputBar: top border 1px text-faint, padding 14/20,
            canvas bg, "say something..." placeholder in text-mute body,
            send button only fades in once content exists (accent icon,
            no fill behind). The TTL chip is a brand-affordance for the
            ephemerality knob — meta-style label, no border, sits inline
            on the icon row. */}
        <View
          style={[
            styles.composer,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
        >
          <View style={styles.inputBar}>
            <Pressable
              onPress={handleGif}
              hitSlop={6}
              style={styles.iconBtn}
              testID="chat-gif"
            >
              <GifIcon size={22} />
            </Pressable>
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
            <TextInput
              testID="chat-input"
              style={[styles.input, { color: themed.ink }]}
              value={input}
              onChangeText={setInput}
              placeholder="say something…"
              placeholderTextColor={themed.slate}
              onSubmitEditing={hasInput ? handleSend : undefined}
              returnKeyType="send"
              multiline
            />
            <Pressable
              onPress={cycleTtl}
              onLongPress={() => setPersistence(conversationId, true)}
              hitSlop={6}
              style={styles.ttlChip}
            >
              <Text style={[styles.ttlText, { color: themed.slate }]}>{ttl.toUpperCase()}</Text>
            </Pressable>
            {hasInput ? (
              <Pressable testID="chat-send" onPress={handleSend} hitSlop={6} style={styles.iconBtn}>
                <SendIcon size={22} color={themed.primary} />
              </Pressable>
            ) : null}
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

function SendIcon({ size = 22, color }: { size?: number; color: string }): React.JSX.Element {
  // Geometric arrow — sharp endpoints (square caps), no fill, accent
  // stroke. Mirrors the input-bar icons' line-weight and feel. Per
  // brand §6.5 the send is "accent icon, no fill behind it".
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 4 L12 20 M5 11 L12 4 L19 11"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  // Brand §6.1 AppBar: 56 min, canvas bg, 1px text-faint bottom border,
  // 18 horizontal / 14 bottom padding. Back chevron + handle (with
  // accent `·` separators) + optional trailing call icon.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 18,
    paddingTop: space.md,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { width: 32, paddingVertical: 4 },
  // Single ‹ — the chevron is the universal "back" cue; the word "Back"
  // adds nothing the chevron doesn't already say. Bigger size matches
  // the brand's geometric, restraint-first ethos.
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  headerHandle: { flex: 1, paddingHorizontal: space.sm },
  // §6.1: handle in `text` (ink), weight 500. Subtitle scale (17pt) so
  // the AppBar reads as a quiet anchor, not a hero header.
  handleText: {
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
    letterSpacing: type.subtitle.size * type.subtitle.letterSpacingEm,
  },
  callBtn: { padding: 6, minWidth: 44, alignItems: 'flex-end' },
  body: { flex: 1 },
  listContent: { padding: space.md, paddingBottom: space.lg },
  // Footnote at the foot of the list — `meta`-style uppercase tag
  // ("MESSAGES DISAPPEAR AFTER THEY'RE SEEN") prefaced by the §6.10
  // brass square. The dot is the only color outside text-mute, pulling
  // attention to the disappearance promise.
  footnote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.lg,
  },
  dot: { width: 6, height: 6 },
  footnoteText: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
  // Brand §6.5 InputBar: 14/20 padding, canvas bg, top hairline border.
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.xs,
  },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // No pill, no fill — input sits flush on the canvas. `body` style for
  // both placeholder and content per §6.5.
  input: {
    flex: 1,
    minHeight: 32,
    maxHeight: 120,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    fontFamily: font.regular,
    fontSize: type.body.size,
  },
  // TTL knob — meta-style label, no border, no fill. Tap cycles the
  // option; long-press flips to persistence. Quiet by design — most
  // sessions use the default and shouldn't be drawn to it.
  ttlChip: {
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  ttlText: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
  },
});
