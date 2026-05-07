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
import { launchImageLibrary } from 'react-native-image-picker';
import { type Attachment, encodePayload, newMessageId } from '@speakeasy/shared';
import { pickFile, pickFromCamera, pickPhotos } from '../attachments/pick.js';
import { saveAndAnnounceFile } from '../attachments/save-and-open.js';
import { GifPickerSheet } from '../components/GifPickerSheet.js';
import { CameraIcon, GifIcon, PaperclipIcon } from '../components/icons/InputBarIcons.js';
import { MediaViewerScreen } from './MediaViewerScreen.js';
import { SignalClientError } from '@speakeasy/crypto';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import { GroupAvatar } from '../components/GroupAvatar.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { useConversations, type ChatMessage } from '../store/conversations.js';
import { useUiState } from '../store/ui.js';
import { useGroups } from '../store/groups.js';
import { useDistributionIds } from '../store/distribution-ids.js';
import { useIdentity } from '../store/identity.js';
import { api, getWsClient, groupMessaging, signalProtocol, vouchflow } from '../services.js';
import { ApiError } from '../api/client.js';
import { makeGroupOrchestrator } from '../crypto/group-orchestration.js';
import { utf8ToBytes } from '../utils/bytes.js';
import { colors, fonts, space, text } from '../theme/index.js';
import { font, type } from '../theme/tokens.js';
import { useColors } from '../theme/index.js';
import Svg, { Path } from 'react-native-svg';

interface Props {
  groupId: string;
  onBack?: () => void;
  /** Open the manage-members screen — tapped from the member-count
   * subline in the chat header. */
  onManageMembers?: () => void;
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
export function GroupChatScreen({ groupId, onBack, onManageMembers }: Props) {
  const themed = useColors();
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
  }, [groupId, openGroup]);

  // Mark read on open AND every time a new inbound message lands while
  // the screen is mounted — see ChatScreen for the rationale.
  useEffect(() => {
    markRead(groupId);
  }, [groupId, markRead, messages.length]);

  // Track the active conversation so the in-app message banner suppresses
  // itself when the user is already on this group.
  useEffect(() => {
    useUiState.getState().setActiveConversation(groupId);
    return () => useUiState.getState().setActiveConversation(undefined);
  }, [groupId]);

  const [input, setInput] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [viewerAttachment, setViewerAttachment] = useState<Attachment | null>(null);
  const [gifSheetOpen, setGifSheetOpen] = useState(false);
  const listRef = useRef<FlatList>(null);
  const upsertGroup = useGroups((s) => s.upsert);
  // Only the creator can change the group avatar. `createdBy` may be
  // undefined until the first `GET /v1/groups/:id` round-trip lands;
  // before that we hide the affordance.
  const isCreator = !!group?.createdBy && group.createdBy === myUserId;

  async function handleChangeGroupAvatar() {
    if (!isCreator || !group) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) return;
    const result = await launchImageLibrary({
      mediaType: 'photo',
      maxWidth: 256,
      maxHeight: 256,
      quality: 0.8,
      includeBase64: true,
      selectionLimit: 1,
    });
    if (result.didCancel) return;
    const asset = result.assets?.[0];
    if (!asset?.base64) {
      Alert.alert('Could not read that image.');
      return;
    }
    setAvatarBusy(true);
    try {
      await api.setGroupAvatar(deviceToken, groupId, asset.base64);
      upsertGroup({
        id: groupId,
        name: group.name,
        members: group.members,
        createdAt: group.createdAt,
        createdBy: group.createdBy,
        avatarB64: asset.base64,
        metadataFetchedAt: Date.now(),
      });
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 403 && e.code === 'not_creator') {
        Alert.alert('Only the group creator can change the photo.');
      } else {
        Alert.alert('Avatar upload failed', String(err));
      }
    } finally {
      setAvatarBusy(false);
    }
  }

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
    setInput('');
    void sendOutbound({ text: trimmed });
  }

  // Group send accepts text and/or attachments. Same v1 envelope as
  // direct chats (`encodePayload`) so the message-router decode path
  // is identical on the receiving side. Attachments go through the
  // sender-key fan-out, just like text.
  async function sendOutbound(opts: { text?: string; attachments?: Attachment[] }) {
    const text = opts.text?.trim() || undefined;
    const attachments = opts.attachments?.length ? opts.attachments : undefined;
    if (!text && !attachments) return;
    if (!group) {
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
    const localId = newMessageId();
    add(groupId, {
      id: localId,
      from: 'me',
      text: text ?? '',
      attachments,
      kind: 'group',
      sentAt: Date.now(),
      stage: 'sent',
    });
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
      const plaintext = encodePayload({ v: 1, text, attachments });
      await orchestrator.sendGroupMessage({
        groupId,
        members: group.members,
        selfUserId: myUserId!,
        plaintext: utf8ToBytes(plaintext),
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
  }

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

  function cycleTtl() {
    const order = ['hour', 'day', 'week', 'month', 'off'] as const;
    const idx = order.indexOf(ttl);
    setTtl(groupId, order[(idx + 1) % order.length]!);
  }

  const hasInput = input.trim().length > 0;
  const memberCount = group?.members.length ?? 0;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <View style={[styles.header, { borderBottomColor: themed.divider }]}>
        {onBack ? (
          <Pressable testID="group-chat-back" onPress={onBack} hitSlop={8} style={styles.back}>
            <Text style={[styles.backText, { color: themed.primary }]}>‹</Text>
          </Pressable>
        ) : (
          <View style={styles.back} />
        )}
        {/* Brand §6.1 AppBar handle. Group avatar kept inline (not on
            the chat list per §7 — but the AppBar permits it, and it's
            the only entry point for the creator's change-photo
            affordance). 32px square per §2.4. */}
        <Pressable
          disabled={!isCreator || avatarBusy}
          onPress={handleChangeGroupAvatar}
          hitSlop={6}
          testID="group-chat-avatar"
          style={styles.avatarBtn}
        >
          <GroupAvatar groupId={groupId} name={group?.name} size={32} />
        </Pressable>
        <Pressable
          style={styles.headerHandle}
          onPress={onManageMembers}
          testID="group-chat-manage-members"
        >
          <Text style={[styles.handleText, { color: themed.ink }]} numberOfLines={1}>
            <Text style={{ color: themed.primary }}>#</Text>
            {' '}
            {group?.name ?? groupId}
          </Text>
          <Text style={[styles.subhead, { color: themed.slate }]} numberOfLines={1}>
            {memberCount} MEMBER{memberCount === 1 ? '' : 'S'} · TAP TO MANAGE
          </Text>
        </Pressable>
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
              attachments={item.attachments}
              stage={item.stage as DisappearingStage}
              variant={item.from === 'me' ? 'sent' : 'received'}
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
              onLongPress={() => setPersistence(groupId, true)}
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

// utf8ToBytes imported from ../utils/bytes — Hermes-safe.

function SendIcon({ size = 22, color }: { size?: number; color: string }): React.JSX.Element {
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
  // Brand §6.1 AppBar — same shape as ChatScreen, but with a leading
  // 32px group avatar (the only change-photo entry point).
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 18,
    paddingTop: space.md,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  back: { width: 32, paddingVertical: 4 },
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  avatarBtn: { },
  headerHandle: { flex: 1 },
  handleText: {
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
    letterSpacing: type.subtitle.size * type.subtitle.letterSpacingEm,
  },
  subhead: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    marginTop: 2,
  },
  body: { flex: 1 },
  listContent: { padding: space.md, paddingBottom: space.lg },
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
  input: {
    flex: 1,
    minHeight: 32,
    maxHeight: 120,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    fontFamily: font.regular,
    fontSize: type.body.size,
  },
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
