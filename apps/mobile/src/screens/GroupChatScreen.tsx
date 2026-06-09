import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import notifee from '@notifee/react-native';
import { clearNotifStack } from '../push/push-handler.js';
import { type Attachment, encodePayload, newMessageId, parseMentions } from '@speakeasy/shared';
import { diag } from '../diag/log.js';
import { pickFile, pickFromCamera, pickPhotos } from '../attachments/pick.js';
import { AppBar } from '../components/AppBar.js';
import { AttachmentSheet } from '../components/AttachmentSheet.js';
import { SEND_TEXT_MAX_CHARS } from '../components/rich-message-text.js';
import { saveAndAnnounceFile } from '../attachments/save-and-open.js';
import { CameraIcon, PaperclipIcon } from '../components/icons/InputBarIcons.js';
import { MediaViewerScreen } from './MediaViewerScreen.js';
import { collectGalleryImages } from '../feed/gallery-images.js';
import { SignalClientError } from '@speakeasy/crypto';
import { DisappearingMessageBubble } from '../components/DisappearingMessageBubble.js';
import { SystemMessageRow } from '../components/SystemMessageRow.js';
import { DateSeparatorRow } from '../components/DateSeparatorRow.js';
import { withDateSeparators } from '../feed/with-date-separators.js';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { Avatar } from '../components/Avatar.js';
import { MentionPicker } from '../components/MentionPicker.js';
import { StatusSquare } from '../components/StatusSquare.js';
import { MutedIcon } from '../components/icons/MutedIcon.js';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';
import { useConversations, type ChatMessage } from '../store/conversations.js';
import { useUiState } from '../store/ui.js';
import { useGroups } from '../store/groups.js';
import { useDistributionIds } from '../store/distribution-ids.js';
import { useIdentity } from '../store/identity.js';
import { api, getWsClient, groupMessaging, signalProtocol, vouchflow } from '../services.js';
import { getDeviceTokenOrVerify } from '../auth/verify-device.js';
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
  /** Open the full-text screen for a long message ("See more" tap). */
  onOpenFullMessage?: (text: string) => void;
  /** Open a 1:1 chat with a handle — tapped from an @mention. */
  onOpenPeer?: (handle: string) => void;
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
export function GroupChatScreen({
  groupId,
  onBack,
  onManageMembers,
  onOpenFullMessage,
  onOpenPeer,
}: Props) {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  if (!myUserId) {
    throw new Error('GroupChatScreen rendered without an enrolled identity');
  }
  const group = useGroups((s) => s.byId[groupId]);
  const messages = useConversations((s) => s.byId[groupId]?.messages ?? EMPTY_MESSAGES);
  const ttl = useConversations((s) => s.byId[groupId]?.ttl ?? 'week');
  const muted = useConversations((s) => s.byId[groupId]?.muted ?? false);
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

  // Hydrate the group's metadata (name + members) if missing — invitees
  // who got added via /v1/groups/:id/members previously had no way to
  // learn the room's name or member list (rc.47 and earlier shipped
  // [group not loaded] errors here). The fetch is idempotent + cached
  // by metadataFetchedAt, so the cost is one round-trip on first open.
  useEffect(() => {
    if (group && group.members.length > 0) return;
    void (async () => {
      try {
        let dt = useIdentity.getState().deviceToken;
        if (!dt) {
          dt = await getDeviceTokenOrVerify(vouchflow, 'group_action');
        }
        const [groupRes, rosterRes] = await Promise.all([
          api.fetchGroup(dt, groupId),
          api.listGroupMembers(dt, groupId),
        ]);
        const memberIds = rosterRes.members;
        const others = memberIds.filter((m) => m !== myUserId).slice(0, 3);
        const fallbackName =
          others.length === 0 ? 'Room' : `Room with @${others.join(', @')}`;
        useGroups.getState().upsert({
          id: groupId,
          name: groupRes.name ?? fallbackName,
          members: memberIds,
          createdAt: Date.now(),
          createdBy: groupRes.created_by,
          metadataFetchedAt: Date.now(),
        });
      } catch (err) {
        diag('group', 'fetch on open failed', {
          groupId,
          err: String(err),
        });
      }
    })();
  }, [groupId, group, myUserId]);

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
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  /** Detect `@` + partial handle in the current input. */
  const handleInputChange = useCallback((text: string) => {
    setInput(text);
    // Find the last `@` that isn't preceded by a non-space char (i.e. start-of-line or after space)
    const match = /(?:^|\s)@([a-z0-9_]*)$/i.exec(text);
    if (match) {
      setMentionQuery(match[1]!.toLowerCase());
    } else {
      setMentionQuery(null);
    }
  }, []);

  /** Insert selected mention handle into the input field. */
  const handleMentionSelect = useCallback((handle: string) => {
    // Replace the trailing `@query` with `@handle `
    setInput((prev) => {
      const idx = prev.lastIndexOf('@');
      if (idx === -1) return prev + `@${handle} `;
      const prefix = prev.slice(0, idx);
      return prefix + `@${handle} `;
    });
    setMentionQuery(null);
    inputRef.current?.focus();
  }, []);
  const [viewerAttachment, setViewerAttachment] = useState<Attachment | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const listRef = useRef<FlatList>(null);
  // The FlatList is `inverted`, so it renders data[0] at the visual
  // bottom — the newest message must come first. The store keeps
  // messages oldest-first, so feed the list a reversed copy.
  const orderedMessages = useMemo(() => [...messages].reverse(), [messages]);
  // Every viewable (image/gif) attachment in this room, in chat order —
  // powers swipe-through paging in the media viewer. See
  // collectGalleryImages.
  const galleryImages = useMemo(() => collectGalleryImages(messages), [messages]);
  // Date-change separators interleaved into the inverted-list data so
  // "Today" / "Yesterday" / etc. sit above the first message of each
  // day. See `withDateSeparators` for the visual-layout reasoning.
  const feedItems = useMemo(() => withDateSeparators(orderedMessages), [orderedMessages]);

  // Opening the group clears its push notification (notifee keys the
  // notification by conversation id, which for a group is the groupId).
  useEffect(() => {
    void notifee.cancelNotification(groupId);
    void clearNotifStack(groupId);
  }, [groupId]);

  // Phase 2 brand overhaul: groups don't have photos OR custom marks.
  // The header tile renders a deterministic geometric room mark from
  // `groupId` via <PortraitTile kind="room">. The previous
  // change-photo affordance was removed along with the server-side
  // PUT /v1/groups/:id/avatar endpoint.

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
      // Dissolve → remove. `ttlMs - elapsedMs` is when the dissolve STARTS;
      // it goes negative once a message is past its TTL. Clamp to 0 and
      // ALWAYS schedule the tail (incl. `remove`) so a message that expired
      // while the app was closed — or whose dissolve started last session
      // and persisted mid-stage ('disappearing'/'almost-gone'/'gone') —
      // still completes and is removed, instead of sticking half-faded
      // forever (bananaman 2026-06-05). The old guard only scheduled
      // removal for 'sent'/'seen' messages with a positive countdown, which
      // orphaned both cases.
      const dissolveAt = Math.max(ttlMs - elapsedMs, 0);
      timers.push(
        setTimeout(() => setStage(groupId, m.id, 'disappearing'), dissolveAt),
        setTimeout(() => setStage(groupId, m.id, 'almost-gone'), dissolveAt + 600),
        setTimeout(() => setStage(groupId, m.id, 'gone'), dissolveAt + 1200),
        setTimeout(() => remove(groupId, m.id), dissolveAt + 1600),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [messages, groupId, ttlSecondsFor, setStage, remove]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput('');
    setMentionQuery(null);
    const mentions = parseMentions(trimmed);
    void sendOutbound({ text: trimmed, mentions: mentions.length ? mentions : undefined });
  }

  // Group send accepts text and/or attachments. Same v1 envelope as
  // direct chats (`encodePayload`) so the message-router decode path
  // is identical on the receiving side. Attachments go through the
  // sender-key fan-out, just like text.
  async function sendOutbound(opts: { text?: string; attachments?: Attachment[]; mentions?: string[] }) {
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
    // Same long-message hard cap as the 1:1 send path
    // (ChatScreen.sendOutbound). See SEND_TEXT_MAX_CHARS for why.
    if (text && text.length > SEND_TEXT_MAX_CHARS) {
      diag('chat', 'group send: text too long — stamped as too_long', {
        groupId,
        textLength: text.length,
        limit: SEND_TEXT_MAX_CHARS,
      });
      add(groupId, {
        id: localId,
        from: 'me',
        text,
        attachments,
        kind: 'group',
        sentAt: Date.now(),
        stage: 'sent',
        sendFailure: 'too_long',
      });
      return;
    }
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
        return getDeviceTokenOrVerify(vouchflow, 'send_message');
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
      const plaintext = encodePayload({ v: 1, text, attachments, mentions: opts.mentions });
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

  // Paperclip → bottom sheet matching the 1:1 ChatScreen path
  // (rc.37). Three explicit options (Photo / Camera / Document) so a
  // gallery JPG always travels with kind: 'image' and renders inline
  // at the recipient instead of as a generic file-icon placeholder.
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

  function cycleTtl() {
    const order = ['hour', 'day', 'week', 'month', 'off'] as const;
    const idx = order.indexOf(ttl);
    setTtl(groupId, order[(idx + 1) % order.length]!);
  }

  const hasInput = input.trim().length > 0;
  const memberCount = group?.members.length ?? 0;
  const ttlLabel = formatTtl(ttl);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      {/* CONVERSATIONS.md §3.2 + §4.1 group variant. Two-line AppBar:
          room mark + `# group-name` + status square (line 1), then a
          meta sub-line `<N> IN THE ROOM · LEAVES IN <TTL>` (line 2).
          Tapping the title block opens manage-members (no kebab). */}
      <AppBar
        onBack={onBack}
        testID="group-chat-appbar"
        leading={<PortraitTile kind="room" id={groupId} size={28} />}
        onTitlePress={onManageMembers}
        titleA11yLabel={`${group?.name ?? groupId}, manage members`}
        title={
          <View style={styles.headerTitleLine}>
            <Text style={[styles.handleText, { color: themed.ink }]} numberOfLines={1}>
              <Text style={{ color: themed.primary }}>#</Text>
              {' '}
              {group?.name ?? groupId}
            </Text>
            <StatusSquare variant="sealed" />
            {muted ? <MutedIcon size={14} color={themed.slate} /> : null}
          </View>
        }
        subtitle={`${memberCount} IN THE ROOM · LEAVES IN ${ttlLabel}`}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <FlatList
          ref={listRef}
          inverted
          data={feedItems}
          keyExtractor={(m) => m.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          renderItem={({ item, index }) => {
            if (item.kind === 'date-separator') {
              return <DateSeparatorRow timestamp={item.sentAt} />;
            }
            // System messages (joins, leaves, name changes, etc.)
            // render as centered captions per CONVERSATIONS.md §3.6.
            if (item.from === 'system') {
              return <SystemMessageRow text={item.text} />;
            }
            // CONVERSATIONS.md §4.2 — group bubbles. Sender attribution
            // row sits above the FIRST bubble of each non-self burst:
            // an 18px room/animal portrait + brass `@handle`. The
            // bubble itself never carries `from:` text anymore — that
            // duplicated the attribution row and felt noisy under the
            // brass header.
            //
            // Burst boundary = the previous message has a different
            // `from`, OR this is the first message in the list.
            // The list is inverted (newest-first), so the
            // conversation-older neighbour is at index + 1. Walk past
            // any date separator between the two so a day boundary
            // doesn't fake a burst boundary.
            const isSelf = item.from === 'me';
            let j = index + 1;
            while (j < feedItems.length && feedItems[j]!.kind === 'date-separator') j++;
            const prevItem = j < feedItems.length ? feedItems[j] : undefined;
            const prev =
              prevItem && prevItem.kind !== 'date-separator' ? prevItem : undefined;
            const showAttribution =
              !isSelf && (!prev || prev.from !== item.from);
            return (
              <View>
                {showAttribution ? (
                  // Tap a sender's portrait/handle to open a 1:1 with them
                  // (feedback rc.40). Only non-self rows show attribution,
                  // so this never targets yourself. Reuses onOpenPeer —
                  // the same Chat-navigation the @mention path is wired to.
                  <Pressable
                    style={styles.attribution}
                    onPress={() => onOpenPeer?.(item.from)}
                    hitSlop={6}
                    testID={`group-sender-${item.from}`}
                  >
                    <Avatar userId={item.from} size={18} />
                    <Handle value={item.from} variant="caption" />
                  </Pressable>
                ) : null}
                <DisappearingMessageBubble
                  text={item.text}
                  attachments={item.attachments}
                  mentions={item.mentions}
                  stage={item.stage as DisappearingStage}
                  variant={isSelf ? 'sent' : 'received'}
                  timestamp={item.sentAt}
                  onTapPhoto={(a) => setViewerAttachment(a)}
                  onTapFile={(a) => void saveAndAnnounceFile(a)}
                  onSeeMore={() => onOpenFullMessage?.(item.text)}
                  // Mentions are inert — rc.19 user feedback said
                  // the tap-to-open behavior was flaky and more
                  // confusing than useful. See the ChatScreen
                  // counterpart for the rationale.
                />
              </View>
            );
          }}
          ListFooterComponent={
            <View style={styles.tagline}>
              <View style={[styles.dot, { backgroundColor: themed.primary }]} />
              <Text style={[styles.taglineText, { color: themed.slate }]}>
                END-TO-END ENCRYPTED · LEAVES IN {ttlLabel}
              </Text>
            </View>
          }
        />
        {mentionQuery !== null && group && (
          <MentionPicker
            query={mentionQuery}
            members={group.members}
            selfUserId={myUserId ?? ''}
            onSelect={handleMentionSelect}
          />
        )}
        <View
          style={[
            styles.composer,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
        >
          <View style={styles.inputBar}>
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
              onChangeText={handleInputChange}
              ref={inputRef}
              placeholder="say something…"
              placeholderTextColor={themed.slate}
              onSubmitEditing={hasInput ? handleSend : undefined}
              returnKeyType="send"
              multiline
              // Once the typed message exceeds `maxHeight` the input
              // would otherwise clip the overflow with no way to reach
              // it. Enabling internal scroll makes a long draft
              // scrollable instead of hidden. (TextInput doesn't
              // expose a JS-side `showsVerticalScrollIndicator` —
              // the indicator appears natively while scrolling.)
              scrollEnabled
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
            items={galleryImages}
            initialIndex={galleryImages.indexOf(viewerAttachment)}
            onClose={() => setViewerAttachment(null)}
            onSave={(a) => void saveAndAnnounceFile(a)}
          />
        ) : null}
      </Modal>
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

// utf8ToBytes imported from ../utils/bytes — Hermes-safe.

/** Group AppBar TTL label — same mapping as ChatScreen.formatTtl. */
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
  // CONVERSATIONS.md §3.2 / §4.1 — two-line AppBar matching ChatScreen.
  headerTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  handleText: {
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
    letterSpacing: type.subtitle.size * type.subtitle.letterSpacingEm,
    flexShrink: 1,
  },
  attribution: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.sm,
    marginBottom: 4,
    paddingHorizontal: space.xs,
  },
  body: { flex: 1 },
  list: { flex: 1 },
  // The list is `inverted`, so the contentContainer is flipped:
  // paddingTop is the visual breathing room above the composer.
  listContent: { padding: space.md, paddingTop: space.lg },
  tagline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginBottom: space.lg,
    paddingTop: space.md,
  },
  dot: { width: 6, height: 6 },
  taglineText: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingVertical: space.md,
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
    paddingVertical: space.sm,
    fontFamily: font.regular,
    fontSize: type.body.size,
  },
  ttlChip: {
    paddingHorizontal: space.sm,
    paddingVertical: 8,
  },
  ttlText: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
  },
});
