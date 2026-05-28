import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
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
import notifee from '@notifee/react-native';
import {
  conversationIdForDirect,
  encodePayload,
  isFeedbackHandle,
  isSpeakerHandle,
  newMessageId,
  parseMentions,
  type Attachment,
} from '@speakeasy/shared';
import { appVersion } from '../version.js';
import { pickFile, pickFromCamera, pickPhotos } from '../attachments/pick.js';
import { AttachmentSheet } from '../components/AttachmentSheet.js';
import { saveAndAnnounceFile } from '../attachments/save-and-open.js';
import { UnblockConfirmSheet } from '../components/BlockSheets.js';
import { CallTypeSheet } from '../components/CallTypeSheet.js';
import { FrozenInputBar } from '../components/FrozenInputBar.js';
import { CameraIcon, PaperclipIcon } from '../components/icons/InputBarIcons.js';
import { PhoneIcon } from '../components/icons/CallIcons.js';
import { AppBar } from '../components/AppBar.js';
import { MutedIcon } from '../components/icons/MutedIcon.js';
import { PeepholeMark } from '../components/PeepholeMark.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { Avatar } from '../components/Avatar.js';
import { Handle } from '../components/Handle.js';
import { StatusSquare } from '../components/StatusSquare.js';
import { useBlocks } from '../store/blocks.js';
import { MediaViewerScreen } from './MediaViewerScreen.js';
import Svg, { Path } from 'react-native-svg';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { SystemMessageRow } from '../components/SystemMessageRow.js';
import { DateSeparatorRow } from '../components/DateSeparatorRow.js';
import { withDateSeparators } from '../feed/with-date-separators.js';
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
import { font, motion, type } from '../theme/tokens.js';
import { useColors } from '../theme/index.js';
import { useConnection } from '../store/connection.js';
import {
  getCachedDeviceTokenOrThrow,
  getDeviceTokenOrVerify,
} from '../auth/verify-device.js';

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
  onStartCall?: (peerId: string, kind: 'audio' | 'video' | 'private') => void;
  /** Open the conversation-settings screen — fired from the AppBar
   * title-block tap. When omitted, the title block becomes inert. */
  onOpenSettings?: () => void;
  /** Open the full-text screen for a long message ("See more" tap). */
  onOpenFullMessage?: (text: string) => void;
  /** Open a 1:1 chat with a handle — tapped from an @mention. */
  onOpenPeer?: (handle: string) => void;
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
export function ChatScreen({
  peerId,
  onBack,
  onStartCall,
  onOpenSettings,
  onOpenFullMessage,
  onOpenPeer,
}: Props) {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  if (!myUserId) {
    throw new Error('ChatScreen rendered without an enrolled identity');
  }
  const conversationId = conversationIdForDirect(myUserId, peerId);
  const messages = useConversations((s) => s.byId[conversationId]?.messages ?? EMPTY_MESSAGES);
  const ttl = useConversations((s) => s.byId[conversationId]?.ttl ?? 'week');
  const muted = useConversations((s) => s.byId[conversationId]?.muted ?? false);
  const ttlSecondsFor = useConversations((s) => s.ttlSecondsFor);
  const add = useConversations((s) => s.add);
  const setStage = useConversations((s) => s.setStage);
  const remove = useConversations((s) => s.remove);
  const setTtl = useConversations((s) => s.setTtl);
  const setPersistence = useConversations((s) => s.setPersistence);
  const openDirect = useConversations((s) => s.openDirect);
  const markRead = useConversations((s) => s.markRead);
  const markDelivered = useConversations((s) => s.markDelivered);
  const markReadReceiptSent = useConversations((s) => s.markReadReceiptSent);
  const setSendFailure = useConversations((s) => s.setSendFailure);

  // BLOCK.md §5: when the local user has blocked this peer, the
  // chat surface enters frozen mode (Peephole portrait, BLOCKED
  // sub-line, no call button, FrozenInputBar in place of the
  // composer). Reads from the local block list — server-side
  // enforcement is a follow-up per BLOCK.md §10.
  const isBlocked = useBlocks((s) => s.isBlocked(peerId));
  const unblockUser = useBlocks((s) => s.unblock);
  const [unblockSheetOpen, setUnblockSheetOpen] = useState(false);
  const [callTypeOpen, setCallTypeOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);

  const [input, setInput] = useState('');
  const [draftContentHeight, setDraftContentHeight] = useState(0);
  const [draftViewportHeight, setDraftViewportHeight] = useState(0);
  // Tap a photo/gif in the bubble → render this attachment fullscreen
  // in a Modal layered over the chat. Null = closed.
  const [viewerAttachment, setViewerAttachment] = useState<Attachment | null>(null);
  const listRef = useRef<FlatList>(null);
  // The FlatList is `inverted`, so it renders data[0] at the visual
  // bottom — the newest message must come first. The store keeps
  // messages oldest-first, so feed the list a reversed copy.
  const orderedMessages = useMemo(() => [...messages].reverse(), [messages]);
  // Date-change separators interleaved into the inverted-list data so
  // "Today" / "Yesterday" / etc. sit above the first message of each
  // day. See `withDateSeparators` for the visual-layout reasoning.
  const feedItems = useMemo(() => withDateSeparators(orderedMessages), [orderedMessages]);

  // Opening the chat clears its push notification (notifee keys the
  // notification by conversation id). Tapping the notification already
  // dismisses it; this covers opening the chat any other way.
  useEffect(() => {
    void notifee.cancelNotification(conversationId);
  }, [conversationId]);

  // BURN.md §5 — feed dissolve. ConvSettings sets
  // `burningConversationId`; we drive the local fade here. The
  // animation runs once on entry, then we pop back to the list
  // (where the row collapse continues). Ref guards re-renders so
  // we don't restart the animation if the screen re-renders mid-
  // dissolve.
  const burningConversationId = useUiState((s) => s.burningConversationId);
  const isBurning = burningConversationId === conversationId;
  const burnFade = useRef(new Animated.Value(1)).current;
  const burnTriggeredRef = useRef(false);
  useEffect(() => {
    if (!isBurning || burnTriggeredRef.current) return;
    burnTriggeredRef.current = true;
    // Spec §5.1 frame 2: opacity drops to 0.32 instantly, then
    // animates to 0 over 600ms ease-out. We run a single timing
    // 1 → 0 — the 0.32 is implicit (the eye sees a gradient pass
    // through it) and avoiding the snap keeps motion continuous.
    Animated.timing(burnFade, {
      toValue: 0,
      duration: motion.dissolve,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onBack?.();
    });
  }, [isBurning, burnFade, onBack]);

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

  // Real read receipts (Phase 6): emit a `read` WS frame for every
  // inbound 1:1 message currently visible in this chat. Track which
  // ids we've already reported via a ref so re-renders (e.g. from
  // the dissolve stage ticker) don't fan out duplicate frames. Skip
  // self-DMs (peerId === myUserId), feedback chat (no peer to
  // notify), and group/community kinds (the wire frame is 1:1 only).
  const readSentRef = useRef<Set<string>>(new Set());
  const wsState = useConnection((s) => s.state);
  useEffect(() => {
    if (peerId === myUserId) return;
    if (isFeedbackHandle(peerId)) return;
    if (isSpeakerHandle(peerId)) return; // @speaker is a one-way broadcast
    const ws = getWsClient(async () => {
      return getCachedDeviceTokenOrThrow();
    });
    // Previously this early-returned when ws wasn't authed yet. That
    // was the bug: if the WS isn't authed on first render (common on
    // cold-start from a push tap), readSentRef stays empty, and the
    // effect doesn't re-run because `messages` hasn't changed by the
    // time WS connects. Now we gate individual sends on wsState and
    // include it in the dependency array so the effect re-fires when
    // the socket becomes authed.
    for (const m of messages) {
      if (m.from !== peerId) continue;
      if (m.kind !== 'direct') continue;
      // Persisted per-message dedup — survives remount AND cold start,
      // so a `read` frame is emitted exactly once per message.
      // readSentRef alone reset on every mount, which re-blasted a
      // `read` for the whole visible history on each chat reopen.
      if (m.readReceiptSent) continue;
      if (readSentRef.current.has(m.id)) continue;
      if (wsState !== 'authed') continue;
      readSentRef.current.add(m.id);
      try {
        ws.send({ type: 'read', to: peerId, message_id: m.id });
        markReadReceiptSent(conversationId, m.id);
      } catch (err) {
        // Drop the id back so a future render can retry once the
        // WS reconnects.
        readSentRef.current.delete(m.id);
        diag('chat', 'read send threw (will retry)', { err: String(err) });
      }
    }
  }, [peerId, myUserId, messages, wsState, conversationId, markReadReceiptSent]);

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
    const mentions = parseMentions(trimmed);
    void sendOutbound({
      text: trimmed,
      mentions: mentions.length ? mentions : undefined,
    });
    // Inverted list: offset 0 is the newest message. Jump there so the
    // user sees their message even if they'd scrolled up into history.
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  // Paperclip → bottom sheet with Photo / Camera / Document choices.
  // Earlier alphas wired the paperclip directly to the document picker
  // for "WhatsApp-style directness", but that meant a JPG picked through
  // the OS document chooser arrived as `kind: 'file'` — receiving end
  // rendered a generic file-icon placeholder instead of the actual
  // image. The sheet makes intent explicit at picker time so photos
  // picked here always travel with `kind: 'image'`.
  function handlePaperclip() {
    setAttachOpen(true);
  }

  async function handlePickPhoto() {
    const photos = await pickPhotos({ selectionLimit: 1 });
    if (photos.length > 0) await sendOutbound({ attachments: photos });
  }

  async function handleCamera() {
    const photo = await pickFromCamera();
    if (photo) await sendOutbound({ attachments: [photo] });
  }

  async function handlePickFile() {
    const file = await pickFile();
    if (file) await sendOutbound({ attachments: [file] });
  }

  async function sendOutbound(opts: {
    text?: string;
    attachments?: Attachment[];
    mentions?: string[];
  }) {
    const text = opts.text?.trim() || undefined;
    const attachments = opts.attachments?.length ? opts.attachments : undefined;
    const mentions = opts.mentions?.length ? opts.mentions : undefined;
    if (!text && !attachments) return;
    const id = newMessageId();
    // Optimistic local echo — render immediately, encrypt + send
    // in the background.
    diag('chat', 'send', {
      convId: conversationId,
      peerId,
      isSelf: peerId === myUserId,
      isFeedback: isFeedbackHandle(peerId),
      hasAttachments: !!attachments,
      attachCount: attachments?.length ?? 0,
    });
    add(conversationId, {
      id,
      from: 'me',
      text: text ?? '',
      attachments,
      mentions,
      kind: 'direct',
      sentAt: Date.now(),
      stage: 'sent',
      // Single ✓ until the server's `delivered` WS frame flips this
      // to true (then the bubble renders ✓✓). On send failure the
      // store stamps `sendFailure`; the bubble renders muted with a
      // "tap to resend" cue and resends under the same id.
      delivered: false,
    });
    await dispatchOutbound({ id, text, attachments, mentions });
  }

  /**
   * Resend a previously-failed bubble. Reuses the existing wire id so
   * the eventual `delivered`/`read` acks attach to the original
   * bubble (the server keys receipts by message_id). Clears the
   * `sendFailure` marker so the bubble loses its muted "tap to
   * resend" treatment while the new attempt is in flight.
   */
  async function retrySend(msg: {
    id: string;
    text?: string;
    attachments?: Attachment[];
    mentions?: string[];
  }) {
    diag('chat', 'send: retry', { msgId: msg.id, peerId });
    setSendFailure(conversationId, msg.id, undefined);
    await dispatchOutbound({
      id: msg.id,
      text: msg.text,
      attachments: msg.attachments,
      mentions: msg.mentions,
    });
  }

  /**
   * The encrypt + WS dispatch half of the send pipeline. Split out of
   * `sendOutbound` so `retrySend` can rerun it against an existing
   * bubble id. On any failure here the store stamps `sendFailure` on
   * the bubble — no parallel "[send failed: …]" message is appended.
   */
  async function dispatchOutbound(args: {
    id: string;
    text?: string;
    attachments?: Attachment[];
    mentions?: string[];
  }) {
    const { id, text, attachments, mentions } = args;
    try {
      let deviceToken = useIdentity.getState().deviceToken;
      if (!deviceToken) {
        diag('chat', 'send: no deviceToken, verification required');
        deviceToken = await getDeviceTokenOrVerify(vouchflow, 'send_message');
      }
      // @feedback fork — POST plaintext to /v1/feedback (NOT E2E),
      // skip Signal session + WS dispatch. Attachments aren't
      // supported here yet (text only); the user sees a banner above
      // the chat making the channel intent clear.
      if (isFeedbackHandle(peerId)) {
        if (text) {
          await api.submitFeedback(deviceToken, text, appVersion());
          // Mark immediately as delivered — there's no remote ack
          // round-trip; the POST 200 IS the ack.
          markDelivered(id);
        }
        diag('chat', 'feedback submitted', { len: text?.length ?? 0 });
        return;
      }
      const isSelf = peerId === myUserId;
      // Pack the text + attachments into the v1 envelope. Pre-rebrand
      // peers see legacy raw utf-8 text — `decodePayload` handles both.
      const plaintext = encodePayload({ v: 1, text, attachments, mentions });
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
        // Stamp the wire frame with the same id as the optimistic
        // bubble so the server's `delivered`/`read` frames come back
        // with an id this bubble actually has — otherwise receipts
        // never attach and the bubble is stuck on a single ✓.
        message_id: id,
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
        msgId: id,
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
              onPress: () =>
                void resendAfterReset({ id, text, attachments, mentions }),
            },
          ],
        );
        return;
      }
      // Stamp the existing bubble as failed so it goes muted with a
      // "tap to resend" cue underneath. We deliberately do NOT append
      // a separate `[send failed: …]` message — that left the
      // optimistic echo lingering with a single ✓ and the failure
      // showing up as a disconnected system bubble.
      const reason =
        err instanceof SignalClientError
          ? `encrypt_failed:${err.reason ?? 'unknown'}`
          : err instanceof ApiError
            ? `send_failed:${err.code ?? err.status ?? 'unknown'}`
            : `send_failed:${e.name ?? 'Error'}`;
      setSendFailure(conversationId, id, reason);
    }
  }

  async function resendAfterReset(opts: {
    id: string;
    text?: string;
    attachments?: Attachment[];
    mentions?: string[];
  }) {
    try {
      await signalProtocol.resetPeer(peerId);
      clearSessionCacheFor(peerId);
      // Retry against the original bubble's wire id so the eventual
      // delivered/read acks attach to the bubble the user can already
      // see — minting a fresh id here would leave receipts orphaned.
      await retrySend({
        id: opts.id,
        text: opts.text,
        attachments: opts.attachments,
        mentions: opts.mentions,
      });
    } catch (err) {
      diag('chat', 'resend after reset FAILED', {
        err: String(err),
        msgId: opts.id,
      });
      setSendFailure(conversationId, opts.id, `reset_failed:${(err as Error).message ?? String(err)}`);
    }
  }

  function cycleTtl() {
    const order = ['hour', 'day', 'week', 'month', 'off'] as const;
    const idx = order.indexOf(ttl);
    setTtl(conversationId, order[(idx + 1) % order.length]!);
  }

  const hasInput = input.trim().length > 0;
  const draftOverflowing =
    hasInput &&
    draftViewportHeight > 0 &&
    draftContentHeight > draftViewportHeight + 2;
  const ttlLabel = formatTtl(ttl);

  return (
    <SafeAreaView testID="chat-screen" style={[styles.root, { backgroundColor: themed.cream }]}>
      {/* CONVERSATIONS.md §3.2 — two-line AppBar: peer portrait +
          handle + brass status square (line 1) + meta-style sub-line
          `E2E · LEAVES IN <TTL>` (line 2). Tap the title block opens
          conversation settings (no kebab menu). For now, no settings
          screen exists at the conversation level — the title block
          stays unpressable; settings live behind the gear in the
          conversation list AppBar. */}
      <AppBar
        onBack={onBack}
        testID="chat-appbar"
        onTitlePress={onOpenSettings}
        titleA11yLabel={`${peerId}, conversation settings`}
        // BLOCK.md §5.1: blocked peers swap the animal portrait for
        // the brass Peephole mark in the same surface tile shape.
        leading={
          isBlocked ? (
            <View
              style={[
                styles.peepholeTile,
                { backgroundColor: themed.pale, borderColor: themed.divider },
              ]}
            >
              <PeepholeMark size={Math.round(28 * 0.78)} />
            </View>
          ) : (
            <Avatar userId={peerId} size={28} />
          )
        }
        title={
          <View style={styles.headerTitleLine}>
            <Handle value={peerId} variant="body" />
            {/* Status square — present for the unblocked path. The
                blocked path drops it (their online state isn't
                visible to you anymore per BLOCK.md §5.1). */}
            {!isBlocked ? <StatusSquare variant="offline" /> : null}
            {muted ? <MutedIcon size={14} color={themed.slate} /> : null}
          </View>
        }
        subtitle={
          isBlocked
            ? 'BLOCKED'
            : isSpeakerHandle(peerId)
              ? 'ANNOUNCEMENTS'
              : isFeedbackHandle(peerId)
                ? 'NOT E2E'
                : `E2E · LEAVES IN ${ttlLabel}`
        }
        // Tapping `LEAVES IN <TTL>` cycles the conversation's TTL —
        // previously this lived as a chip in the composer trailing
        // slot, which crowded out the send button. The toggle now
        // lives where the value is already shown, and the composer
        // gets its expected send-button slot back. Long-press flips
        // persistence on. Disabled on speaker / feedback / blocked
        // surfaces where TTL is fixed by the channel.
        onSubtitlePress={
          isBlocked || isSpeakerHandle(peerId) || isFeedbackHandle(peerId)
            ? undefined
            : cycleTtl
        }
        onSubtitleLongPress={
          isBlocked || isSpeakerHandle(peerId) || isFeedbackHandle(peerId)
            ? undefined
            : () => setPersistence(conversationId, true)
        }
        subtitleA11yLabel={`Message lifetime: ${ttlLabel}. Tap to change.`}
        // CALLS.md §01: tapping ☎ opens the call-type sheet, not an
        // immediate call. Hidden when blocked per BLOCK.md §5.1.
        trailing={
          onStartCall &&
          !isBlocked &&
          !isFeedbackHandle(peerId) &&
          !isSpeakerHandle(peerId) ? (
            <Pressable
              testID="chat-call"
              onPress={() => setCallTypeOpen(true)}
              hitSlop={8}
              style={styles.callBtn}
            >
              <PhoneIcon size={22} color={themed.primary} />
            </Pressable>
          ) : undefined
        }
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        {/* BURN.md §5: feed-fade wrapper. AppBar above stays at full
            opacity so the conversation's identity is recognizable
            while its content fades — the dissolve reads as a
            deliberate ending, not a glitch. */}
        <Animated.View style={{ flex: 1, opacity: burnFade }}>
        <FlatList
          ref={listRef}
          inverted
          data={feedItems}
          keyExtractor={(m) => m.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            if (item.kind === 'date-separator') {
              return <DateSeparatorRow timestamp={item.sentAt} />;
            }
            if (item.from === 'system') {
              return <SystemMessageRow text={item.text} />;
            }
            return (
              <DisappearingMessageBubble
                text={item.text}
                attachments={item.attachments}
                mentions={item.mentions}
                stage={item.stage as DisappearingStage}
                variant={item.from === 'me' ? 'sent' : 'received'}
                delivered={item.delivered}
                read={!!item.readAt}
                timestamp={item.sentAt}
                sendFailure={item.sendFailure}
                onTapResend={
                  item.from === 'me' && item.sendFailure
                    ? () =>
                        void retrySend({
                          id: item.id,
                          text: item.text,
                          attachments: item.attachments,
                          mentions: item.mentions,
                        })
                    : undefined
                }
                onTapPhoto={(a) => setViewerAttachment(a)}
                onTapFile={(a) => void saveAndAnnounceFile(a)}
                onSeeMore={() => onOpenFullMessage?.(item.text)}
                onMentionPress={(h) => {
                  // Tapping the current peer or yourself is a no-op.
                  if (h !== myUserId && h !== peerId) onOpenPeer?.(h);
                }}
              />
            );
          }}
          ListFooterComponent={
            <View style={styles.tagline}>
              <View style={[styles.dot, { backgroundColor: themed.primary }]} />
              <Text style={[styles.taglineText, { color: themed.slate }]}>
                {isSpeakerHandle(peerId)
                  ? 'ANNOUNCEMENTS · FROM SPEAKEASY'
                  : isFeedbackHandle(peerId)
                    ? 'NOT E2E · GOES TO THE DEV TEAM'
                    : `END-TO-END ENCRYPTED · LEAVES IN ${ttlLabel}`}
              </Text>
            </View>
          }
        />
        {/* Brand §6.5 InputBar: top border 1px text-faint, padding 14/20,
            canvas bg, "say something..." placeholder in text-mute body,
            send button only fades in once content exists (accent icon,
            no fill behind). The TTL chip is a brand-affordance for the
            ephemerality knob — meta-style label, no border, sits inline
            on the icon row.

            BLOCK.md §5.2: when the conversation is frozen, the whole
            composer is replaced with the FrozenInputBar (caption "You
            blocked them." + brass "Unblock"). */}
        {isBlocked ? (
          <FrozenInputBar onUnblock={() => setUnblockSheetOpen(true)} />
        ) : isSpeakerHandle(peerId) ? (
          // @speaker is a one-way broadcast — no composer, just a note
          // where the input bar would be.
          <View
            style={[
              styles.composer,
              { backgroundColor: themed.cream, borderTopColor: themed.divider },
            ]}
          >
            <Text style={[styles.speakerNote, { color: themed.slate }]}>
              Announcements only — you can't reply here
            </Text>
          </View>
        ) : (
        <View
          style={[
            styles.composer,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
        >
          <View style={styles.inputBar}>
            {/* @feedback is text-only — attachments aren't stored in
                /v1/feedback yet. Hide the paperclip + camera buttons
                so the affordances match the channel's capabilities. */}
            {!isFeedbackHandle(peerId) ? (
              <>
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
              </>
            ) : null}
            <View style={styles.inputWrap}>
              <TextInput
                testID="chat-input"
                style={[styles.input, { color: themed.ink }]}
                value={input}
                onChangeText={setInput}
                onLayout={(e) => setDraftViewportHeight(e.nativeEvent.layout.height)}
                onContentSizeChange={(e) =>
                  setDraftContentHeight(e.nativeEvent.contentSize.height)
                }
                placeholder="say something…"
                placeholderTextColor={themed.slate}
                onSubmitEditing={hasInput ? handleSend : undefined}
                returnKeyType="send"
                multiline
                // Once the typed message exceeds `maxHeight` the input
                // would otherwise clip the overflow with no way to reach
                // it. Enabling internal scroll makes a long draft
                // scrollable instead of hidden. Android does not always
                // show its native scroll indicator, so we render a small
                // explicit cue below once overflow is detected.
                scrollEnabled
              />
              {draftOverflowing ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.inputScrollCue,
                    { backgroundColor: themed.slate },
                  ]}
                  testID="chat-input-scroll-cue"
                />
              ) : null}
            </View>
            {/* Send button on the composer trailing edge — the spot
                users expect it to be. The TTL toggle moved to the
                AppBar's `LEAVES IN <TTL>` sub-line. The send glyph
                stays dimmed and disabled until there's something to
                send, rather than appearing/disappearing on each
                keystroke. */}
            <Pressable
              testID="chat-send"
              onPress={hasInput ? handleSend : undefined}
              disabled={!hasInput}
              hitSlop={6}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !hasInput }}
            >
              <SendIcon
                size={22}
                color={hasInput ? themed.primary : themed.slate}
              />
            </Pressable>
          </View>
        </View>
        )}
        </Animated.View>
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
            onSave={() => void saveAndAnnounceFile(viewerAttachment)}
          />
        ) : null}
      </Modal>
      <UnblockConfirmSheet
        visible={unblockSheetOpen}
        handle={peerId}
        onClose={() => setUnblockSheetOpen(false)}
        onConfirm={() => {
          setUnblockSheetOpen(false);
          unblockUser(peerId);
        }}
      />
      <CallTypeSheet
        visible={callTypeOpen}
        peerUserId={peerId}
        onClose={() => setCallTypeOpen(false)}
        onPickVoice={() => onStartCall?.(peerId, 'audio')}
        onPickVideo={() => onStartCall?.(peerId, 'video')}
        onPickPrivate={() => onStartCall?.(peerId, 'private')}
      />
      <AttachmentSheet
        visible={attachOpen}
        onClose={() => setAttachOpen(false)}
        onPickPhoto={() => void handlePickPhoto()}
        onPickCamera={() => void handleCamera()}
        onPickFile={() => void handlePickFile()}
      />
    </SafeAreaView>
  );
}

// -- helpers ----------------------------------------------------------------

// utf8ToBytes / bytesToB64 imported from ../utils/bytes — they're
// Hermes-safe (no Buffer dependency). The previous Buffer-based inline
// helpers crashed on first send because Hermes doesn't ship Buffer.

/**
 * Render the conversation TTL as a meta-style label fragment.
 * Drives the AppBar sub-line `E2E · LEAVES IN <X>`. Uppercase + terse:
 * "1H" / "24H" / "7D" / "30D" / "OFF". Keeps consistent with the
 * spec's `meta` typography (10px, ls 0.18em, uppercase).
 */
function formatTtl(ttl: string): string {
  switch (ttl) {
    case 'hour':
      return '1H';
    case 'day':
      return '24H';
    case 'week':
      return '7D';
    case 'month':
      return '30D';
    case 'off':
      return 'OFF';
    default:
      return ttl.toUpperCase();
  }
}

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
  // Frozen-state Peephole portrait — sized to match the standard
  // animal portrait tile (28×28 surface tile + faint border + 78%
  // inner mark) so the AppBar layout doesn't shift when block toggles.
  peepholeTile: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  headerTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  callBtn: { padding: space.sm, minWidth: 44, alignItems: 'flex-end' },
  body: { flex: 1 },
  list: { flex: 1 },
  // The list is `inverted`, so the contentContainer is flipped:
  // paddingTop here is the visual breathing room above the composer
  // (below the newest message).
  listContent: { padding: space.md, paddingTop: space.lg },
  // Tagline at the top of the conversation — `meta`-style uppercase
  // ("END-TO-END ENCRYPTED · LEAVES IN <TTL>") prefaced by the §6.10
  // brass square. The list is inverted, so it rides in
  // ListFooterComponent, which renders at the visual top — reading as
  // the conversation's ground truth, not a rolling tail.
  // The dot is the only color outside text-mute.
  tagline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginBottom: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    paddingHorizontal: space.lg,
  },
  dot: { width: 6, height: 6 },
  taglineText: {
    flexShrink: 1,
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  // Brand §6.5 InputBar: 14/20 padding, canvas bg, top hairline border.
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingVertical: space.md,
  },
  speakerNote: {
    fontFamily: font.regular,
    fontSize: 13,
    textAlign: 'center',
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
  inputWrap: {
    flex: 1,
    position: 'relative',
  },
  input: {
    minHeight: 32,
    maxHeight: 120,
    paddingLeft: space.sm,
    paddingRight: space.lg,
    paddingVertical: space.sm,
    fontFamily: font.regular,
    fontSize: type.body.size,
  },
  inputScrollCue: {
    position: 'absolute',
    right: 6,
    top: 10,
    bottom: 10,
    width: 2,
    opacity: 0.45,
  },
});
