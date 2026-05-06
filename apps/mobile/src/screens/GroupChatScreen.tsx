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
import { colors, fonts, radius, space, text } from '../theme/index.js';

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

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable testID="group-chat-back" onPress={onBack} style={styles.back}>
            <Text style={[text.subtitle, { color: colors.primary }]}>‹ Back</Text>
          </Pressable>
        ) : null}
        <View style={styles.headerRow}>
          <Pressable
            disabled={!isCreator || avatarBusy}
            onPress={handleChangeGroupAvatar}
            hitSlop={6}
            testID="group-chat-avatar"
          >
            <GroupAvatar groupId={groupId} name={group?.name} size={40} />
          </Pressable>
          <Pressable
            style={styles.headerText}
            onPress={onManageMembers}
            testID="group-chat-manage-members"
          >
            <Text style={[text.heroBody, styles.peer]} numberOfLines={1}>
              # {group?.name ?? groupId}
            </Text>
            <Text style={[text.footnote, styles.subhead]}>
              {group
                ? `${group.members.length} member${group.members.length === 1 ? '' : 's'} · tap to manage${isCreator ? ' · photo above' : ''}`
                : ''}
            </Text>
          </Pressable>
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
            <Text style={[text.footnote, styles.footnote]}>
              {'Messages disappear after they’re seen.'}
            </Text>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />
        <View style={styles.composer}>
          <Pressable
            onPress={cycleTtl}
            onLongPress={() => setPersistence(groupId, true)}
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
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerText: { flex: 1 },
  peer: { color: colors.ink, fontFamily: fonts.inter500 },
  subhead: { color: colors.slate },
  body: { flex: 1 },
  listContent: { padding: space.md, paddingBottom: space.lg },
  footnote: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.lg,
  },
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
