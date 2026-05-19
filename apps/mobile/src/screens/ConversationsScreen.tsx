import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppBar } from '../components/AppBar.js';
import { FindSomeoneSheet } from '../components/FindSomeoneSheet.js';
import {
  GetStartedCards,
  GET_STARTED_CARD_IDS,
} from '../components/GetStartedCards.js';
import { useOnboardingCards } from '../store/onboarding-cards.js';
import { Handle } from '../components/Handle.js';
import { PeepholeMark } from '../components/PeepholeMark.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { Avatar } from '../components/Avatar.js';
import { StatusSquare } from '../components/StatusSquare.js';
import { useBlocks } from '../store/blocks.js';
import { SettingsIcon } from '../components/icons/SettingsIcon.js';
import { useColors } from '../theme/index.js';
import { colors, fonts, space, text } from '../theme/index.js';
import { font, motion, type } from '../theme/tokens.js';
import { useConnection } from '../store/connection.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { useUiState } from '../store/ui.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { diag } from '../diag/log.js';

interface DirectRow {
  kind: 'direct';
  conversationId: string;
  peerUserId: string;
  preview: string;
  /** Whether the last message is from the local user (`'me'`). Drives
   * the optional `you: ` prefix on the preview per CONVERSATIONS.md
   * §2.4. */
  previewIsSelf: boolean;
  sortKey: number;
  unread: number;
  lastActivityAt: number;
}
interface GroupRow {
  kind: 'group';
  groupId: string;
  name: string;
  memberCount: number;
  preview: string;
  /** Sender of the last message: 'me' for outgoing, peer userId
   * otherwise. The list row renders this as a brass `@sender:` prefix
   * before the preview text — same brass-glyph treatment as the
   * AppBar handle. Undefined when the group has no messages yet. */
  previewSender?: string;
  sortKey: number;
  unread: number;
  lastActivityAt: number;
}
type Row = DirectRow | GroupRow;

interface Props {
  onOpenChat: (peerUserId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onNewGroup: () => void;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onShareHandle: () => void;
}

/**
 * Combined conversations list — direct chats + groups, sorted by most-
 * recent activity. Brand §7 (workspace): flat ListItems with a hairline
 * `text-ghost` divider, no avatars, timestamp on long-press only.
 * Trailing accent indicator marks unread rows (brand §6.8).
 */
export function ConversationsScreen({
  onOpenChat,
  // onNewChat removed in the deep-link migration — the FAB and the
  // GetStartedCards "Start a chat" affordance both open the Find
  // Someone sheet directly, no separate route to NewChat.
  onOpenGroup,
  onNewGroup,
  onOpenSettings,
  onShareHandle,
}: Props) {
  const userId = useIdentity((s) => s.userId);
  const wsState = useConnection((s) => s.state);
  const conversationsById = useConversations((s) => s.byId);
  const groupsById = useGroups((s) => s.byId);
  const unreadCountFor = useConversations((s) => s.unreadCountFor);
  const openDirect = useConversations((s) => s.openDirect);
  const blockedByHandle = useBlocks((s) => s.byHandle);
  const ownAnimalId = useProfiles((s) =>
    userId ? s.byUserId[userId]?.selectedAvatarId : undefined,
  );
  const themed = useColors();

  const directRows: DirectRow[] = Object.entries(conversationsById)
    .filter(([_, c]) => c.kind === 'direct' && !!c.peerUserId)
    .map(([conversationId, c]) => {
      const last = c.messages[c.messages.length - 1];
      return {
        kind: 'direct' as const,
        conversationId,
        peerUserId: c.peerUserId!,
        preview: last?.text ?? 'No messages yet',
        previewIsSelf: last?.from === 'me',
        sortKey: last?.sentAt ?? c.createdAt,
        unread: unreadCountFor(conversationId),
        lastActivityAt: last?.sentAt ?? c.createdAt,
      };
    });

  const groupRows: GroupRow[] = Object.entries(groupsById).map(([groupId, g]) => {
    const conv = conversationsById[groupId];
    const last = conv?.messages[conv.messages.length - 1];
    return {
      kind: 'group' as const,
      groupId,
      name: g.name,
      memberCount: g.members.length,
      preview: last?.text ?? 'No messages yet',
      previewSender: last?.from,
      sortKey: last?.sentAt ?? g.createdAt,
      unread: conv ? unreadCountFor(groupId) : 0,
      lastActivityAt: last?.sentAt ?? g.createdAt,
    };
  });

  const rows: Row[] = [...directRows, ...groupRows].sort((a, b) => b.sortKey - a.sortKey);
  // Dock the get-started prompt above the FAB when the user has 1–4
  // conversations (still building their room). At zero, the empty
  // hero renders the same prompt inline — the dock would duplicate
  // it. At 5+, the user's room is full enough that the prompt
  // becomes noise. Once dismissed, the dock collapses and the FAB
  // drops back to its default bottom position. The FAB lift is
  // measured from the dock's real height (`dockHeight`) rather than
  // a fixed offset, so it stays correct if the prompt's layout
  // changes.
  const dismissedCards = useOnboardingCards((s) => s.dismissed);
  const allCardsDismissed =
    GET_STARTED_CARD_IDS.every((id: string) => dismissedCards[id]);
  const showGetStarted =
    rows.length > 0 && rows.length < 5 && !allCardsDismissed;

  // The brand spec hides timestamps by default and reveals on
  // long-press (§7). Track which row id is currently revealed; clear
  // after a short window so the row reverts to its quiet default.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  // Measured height of the get-started dock — drives the FAB lift so
  // the brass `+` always clears the prompt. 0 until first layout;
  // a one-frame fallback below covers that initial paint.
  const [dockHeight, setDockHeight] = useState(0);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Brass `+` FAB opens the Find Someone sheet (NEW-CONVERSATION.md
  // §3). Handle search is the common case; "create a room →" lives
  // in the sheet's footer.
  const [sheetOpen, setSheetOpen] = useState(false);
  // Deep-link lands here with a pending handle to look up — open the
  // sheet pre-filled, then clear so a back-and-forward navigation
  // doesn't re-pop it. NEW-CONVERSATION.md §6.1.
  const pendingFindHandle = useUiState((s) => s.pendingFindHandle);
  const [initialFindHandle, setInitialFindHandle] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    if (pendingFindHandle) {
      setInitialFindHandle(pendingFindHandle);
      setSheetOpen(true);
      useUiState.getState().setPendingFindHandle(undefined);
    }
  }, [pendingFindHandle]);
  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
  }, []);
  const reveal = (id: string) => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    setRevealedId(id);
    revealTimer.current = setTimeout(() => setRevealedId(null), 1800);
  };

  return (
    <SafeAreaView
      testID="conversations-screen"
      style={[styles.root, { backgroundColor: themed.cream }]}
    >
      {/* CONVERSATIONS.md §2.2 — list AppBar with self portrait
          (28px) + handle + brass status square + settings glyph.
          Compact, single-line; the longer "YOU ARE"-eyebrow hero from
          the previous iteration competed with the row content. */}
      <AppBar
        testID="conversations-appbar"
        leading={
          userId ? (
            <PortraitTile
              kind="animal"
              id={ownAnimalId ?? defaultAnimalForUser(userId)}
              size={28}
            />
          ) : (
            <View style={styles.headerSelfPlaceholder} />
          )
        }
        title={
          <View style={styles.headerHandle} testID="conversations-userid">
            {userId ? (
              <Handle value={userId} variant="body" />
            ) : (
              <Text style={[styles.handlePlaceholder, { color: themed.slate }]}>—</Text>
            )}
            <StatusSquare variant={wsState === 'authed' ? 'online' : 'offline'} />
          </View>
        }
        trailing={
          <Pressable
            onPress={onOpenSettings}
            // Long-press → emergency diag dump to clipboard. If a UI
            // bug elsewhere blocks navigation to Diagnostics (rc.25
            // FAB-freeze report), this escape hatch lets the user
            // capture the diag log without having to traverse the
            // settings tree.
            onLongPress={() => {
              void (async () => {
                try {
                  const { formatDiag, getDiagSnapshot } = await import(
                    '../diag/log.js'
                  );
                  const Clipboard = (
                    await import('@react-native-clipboard/clipboard')
                  ).default;
                  Clipboard.setString(formatDiag(getDiagSnapshot()));
                } catch {
                  /* clipboard unavailable — best-effort */
                }
              })();
            }}
            delayLongPress={1500}
            hitSlop={8}
            style={styles.gearBtn}
            testID="conversations-settings-btn"
          >
            <SettingsIcon size={24} />
          </Pressable>
        }
      />

      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'direct' ? r.conversationId : r.groupId)}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          // Centered hero — workspace canvas, 64px self-portrait
          // + display handle with brass `@` + brand-voice copy line
          // + inline GetStartedCards. Replaces the bare
          // "No conversations yet." text. The dock-mode GetStarted
          // pad is suppressed for this case (would duplicate the
          // cards rendered inline here).
          <View style={styles.emptyHero} testID="conversations-empty-hero">
            {/* Upper block — portrait + handle + voice line, vertically
                centered in the empty area's top ~60%. Anchored as a
                discrete unit so the lower cards block has its own
                breathing room rather than reading as the same group. */}
            <View style={styles.emptyHeroTop}>
              {userId ? (
                <PortraitTile
                  kind="animal"
                  id={ownAnimalId ?? defaultAnimalForUser(userId)}
                  size={64}
                />
              ) : null}
              {userId ? (
                <View style={styles.emptyHeroHandle}>
                  <Handle value={userId} variant="display" />
                </View>
              ) : null}
              <Text style={[styles.emptyHeroLine, { color: themed.slate }]}>
                your room's quiet — share your handle to fill it
                <Text style={{ color: themed.primary }}>.</Text>
              </Text>
            </View>
            {/* Lower block — get-started cards, separated from the
                hero so they read as a distinct call-to-action affordance
                rather than caboose to the voice line above. */}
            <View style={styles.emptyHeroCards}>
              <GetStartedCards
                onShareHandle={onShareHandle}
                onNewGroup={onNewGroup}
                onNewChat={() => setSheetOpen(true)}
              />
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const id = item.kind === 'direct' ? item.conversationId : item.groupId;
          const onPress = () =>
            item.kind === 'direct' ? onOpenChat(item.peerUserId) : onOpenGroup(item.groupId);
          const showTimestamp = revealedId === id;
          return (
            <BurningRow conversationId={id}>
            <Pressable
              onPress={onPress}
              onLongPress={() => reveal(id)}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: themed.divider },
                pressed && { backgroundColor: themed.soft },
              ]}
            >
              {/* Portrait tile — animal for 1:1, room mark for group.
                  CONVERSATIONS.md §2.4. 36×36 keeps the row's left
                  edge consistent regardless of which animal renders
                  (a stag's antlers don't blow out the row). */}
              {item.kind === 'direct' ? (
                blockedByHandle[item.peerUserId] ? (
                  // BLOCK.md §5.4: blocked 1:1 rows render the
                  // Peephole mark in place of the peer's animal.
                  <View
                    style={[
                      styles.peepholeRow,
                      {
                        backgroundColor: themed.pale,
                        borderColor: themed.divider,
                      },
                    ]}
                  >
                    <PeepholeMark size={Math.round(36 * 0.78)} />
                  </View>
                ) : (
                  <Avatar userId={item.peerUserId} size={36} />
                )
              ) : (
                <PortraitTile kind="room" id={item.groupId} size={36} />
              )}
              <View style={styles.rowBody}>
                {item.kind === 'direct' ? (
                  // <Handle> renders brass `@` + handle as separate
                  // spans — same brand glyph treatment as the AppBar
                  // and elsewhere. Single source for handle rendering.
                  <Handle value={item.peerUserId} variant="body" />
                ) : (
                  <Text
                    style={[styles.groupName, { color: themed.ink }]}
                    numberOfLines={1}
                  >
                    {item.name}
                  </Text>
                )}
                <Text
                  style={[styles.rowSubtitle, { color: themed.slate }]}
                  numberOfLines={1}
                >
                  {renderPreview(item, themed.primary)}
                </Text>
                {showTimestamp ? (
                  <Text style={[styles.rowTimestamp, { color: themed.slate }]}>
                    {relativeTime(item.lastActivityAt).toUpperCase()}
                  </Text>
                ) : null}
              </View>
              {/* Time + unread square right column. CONVERSATIONS.md
                  §2.4: time is one terse unit (no "5 minutes ago"),
                  unread is a single 7×7 brass square — no count, no
                  bold, no badge. Per-row layout reserves the square
                  slot whether unread or not so widths don't shift on
                  read-state changes. */}
              <View style={styles.meta}>
                <Text style={[styles.metaTime, { color: themed.slate }]}>
                  {relativeTime(item.lastActivityAt)}
                </Text>
                <View
                  style={[
                    styles.unreadMark,
                    { backgroundColor: item.unread > 0 ? themed.primary : 'transparent' },
                  ]}
                />
              </View>
            </Pressable>
            </BurningRow>
          );
        }}
      />

      {showGetStarted ? (
        <View
          style={[styles.getStartedDock, { backgroundColor: themed.cream, borderTopColor: themed.divider }]}
          onLayout={(e) => setDockHeight(e.nativeEvent.layout.height)}
        >
          <GetStartedCards
            onShareHandle={onShareHandle}
            onNewGroup={onNewGroup}
            onNewChat={() => setSheetOpen(true)}
          />
        </View>
      ) : null}

      <View
        pointerEvents="box-none"
        style={[
          styles.fabStack,
          // Lift the FAB clear of the dock. `dockHeight || 220` covers
          // the first frame before onLayout measures the real height.
          showGetStarted
            ? { bottom: (dockHeight || 220) + space.md }
            : null,
        ]}
      >
        <Pressable
          testID="conversations-fab"
          onPress={() => {
            diag('ui', 'fab tap → open find sheet', { sheetWasOpen: sheetOpen });
            setSheetOpen(true);
          }}
          // Long-press FAB → silently copy diag log to clipboard. The
          // FAB is always on screen and its touch path is the single
          // surface that we *know* still works regardless of overlay
          // state. Long-press fires before onPress is dispatched, so
          // holding the FAB never accidentally opens the sheet.
          onLongPress={() => {
            void (async () => {
              try {
                const { formatDiag, getDiagSnapshot } = await import(
                  '../diag/log.js'
                );
                const Clipboard = (
                  await import('@react-native-clipboard/clipboard')
                ).default;
                Clipboard.setString(formatDiag(getDiagSnapshot()));
                diag('ui', 'fab long-press → diag copied to clipboard');
              } catch (err) {
                diag('ui', 'fab long-press → copy failed', {
                  err: String(err),
                });
              }
            })();
          }}
          delayLongPress={1500}
          style={[styles.fabPrimary, { backgroundColor: themed.primary }]}
          android_ripple={{ color: themed.soft, borderless: false }}
        >
          <Text style={[styles.fabPlus, { color: themed.cream }]}>+</Text>
        </Pressable>
      </View>

      {/* NEW-CONVERSATION.md §3: Find Someone sheet replaces the
          previous two-row "new chat / new room" picker. The sheet
          IS the entry point — handle search is the common case;
          room creation is the secondary footer link. */}
      <FindSomeoneSheet
        visible={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          setInitialFindHandle(undefined);
        }}
        initialHandle={initialFindHandle}
        onPickPeer={(peerId) => {
          if (userId) openDirect(userId, peerId);
          onOpenChat(peerId);
        }}
        onCreateRoom={onNewGroup}
      />
    </SafeAreaView>
  );
}

/**
 * Render the row preview line. For direct chats with an outgoing last
 * message, prefix `you: ` in `text-mute` (no brass — your own
 * attribution doesn't need brand emphasis here). For group chats,
 * prefix `@<sender>: ` in brass + slate, per CONVERSATIONS.md §2.4.
 *
 * Returns a React node (mixed-color spans) wrapped inside the parent
 * Text. The parent's `numberOfLines={1}` truncates the whole line.
 */
/**
 * BURN.md §7 — row-collapse animation.
 *
 * When the conversation matches `burningConversationId`, the row
 * runs a 600ms ease-out collapse: opacity 1 → 0 + maxHeight 80 → 0
 * (the +16 over the standard 64px row absorbs vertical padding so
 * the collapse looks clean rather than a flat empty band).
 *
 * After completion: drop the conversation from the store and clear
 * the burn flag. Idempotent — multiple matching rows on the screen
 * (which shouldn't happen, but defensive) all reach the same end
 * state.
 */
function BurningRow({
  conversationId,
  children,
}: {
  conversationId: string;
  children: React.ReactNode;
}): React.ReactElement {
  const burningId = useUiState((s) => s.burningConversationId);
  const isBurning = burningId === conversationId;
  const removeConvo = useConversations((s) => s.removeConversation);
  const fade = useRef(new Animated.Value(1)).current;
  const height = useRef(new Animated.Value(80)).current;
  const triggered = useRef(false);
  useEffect(() => {
    if (!isBurning || triggered.current) return;
    triggered.current = true;
    // Spec §5.1 timing — wait 250ms after the screen-pop transition
    // lands the user on the list, then collapse over 600ms.
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 0,
          duration: motion.dissolve,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
        Animated.timing(height, {
          toValue: 0,
          duration: motion.dissolve,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]).start(({ finished }) => {
        if (!finished) return;
        removeConvo(conversationId);
        useUiState.getState().setBurningConversationId(undefined);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [isBurning, conversationId, fade, height, removeConvo]);
  if (!isBurning) {
    return <>{children}</>;
  }
  return (
    <Animated.View style={{ opacity: fade, maxHeight: height, overflow: 'hidden' }}>
      {children}
    </Animated.View>
  );
}

function renderPreview(
  item:
    | { kind: 'direct'; preview: string; previewIsSelf: boolean }
    | { kind: 'group'; preview: string; previewSender?: string },
  brassColor: string,
): React.ReactNode {
  if (item.kind === 'direct') {
    if (item.previewIsSelf) {
      return (
        <>
          <Text>you: </Text>
          <Text>{item.preview}</Text>
        </>
      );
    }
    return item.preview;
  }
  // group
  if (!item.previewSender) {
    // No messages yet — just the literal preview text ("No messages
    // yet"). Without a sender there's nothing to brass-prefix.
    return item.preview;
  }
  if (item.previewSender === 'me') {
    return (
      <>
        <Text>you: </Text>
        <Text>{item.preview}</Text>
      </>
    );
  }
  return (
    <>
      <Text style={{ color: brassColor }}>@{item.previewSender}: </Text>
      <Text>{item.preview}</Text>
    </>
  );
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
  headerSelfPlaceholder: { width: 28, height: 28 },
  headerHandle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  handlePlaceholder: {
    fontFamily: font.medium,
    fontSize: type.body.size,
  },
  gearBtn: { padding: space.sm },

  // CONVERSATIONS.md §2.4: row 64ish (expands w/ content), padding
  // 14/16, 1px text-ghost bottom border (subtler than text-faint —
  // these stack and we don't want a ladder), portrait 36×36, 12px
  // gap to body, body flex: 1.
  listContent: { paddingBottom: space.xl },
  emptyContainer: {
    flex: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  emptyText: { color: colors.slate },
  emptyHero: {
    flex: 1,
    alignItems: 'center',
    // Two stacked blocks: upper (portrait+handle+line) takes the
    // upper half, lower (cards) sits in its own 40% with breathing
    // room above. `space-around` gives both blocks symmetrical
    // padding from the edges of the empty area, which reads as
    // intentionally laid out rather than centered-by-accident.
    justifyContent: 'space-around',
    paddingVertical: space.xl,
  },
  emptyHeroTop: { alignItems: 'center', gap: space.md },
  emptyHeroHandle: { marginTop: -4 },
  emptyHeroLine: {
    fontFamily: font.regular,
    fontSize: type.caption.size,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 32 * 8,
    marginTop: 4,
    marginBottom: 12,
  },
  emptyHeroCards: { alignSelf: 'stretch', marginHorizontal: -space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 64,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, gap: space.xs, minWidth: 0 },
  groupName: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: -0.005 * 14,
  },
  rowSubtitle: {
    fontFamily: font.regular,
    fontSize: 12.5,
  },
  rowTimestamp: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  // Right-aligned meta column — time on top, unread square below
  // (or transparent reservation so the row doesn't shift width when
  // unread state changes).
  meta: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: space.sm,
    flexShrink: 0,
  },
  metaTime: {
    fontFamily: font.regular,
    fontSize: 11,
    letterSpacing: 0.02 * 11,
  },
  unreadMark: {
    width: 7,
    height: 7,
  },
  getStartedDock: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fabStack: {
    position: 'absolute',
    right: space.lg,
    bottom: space.lg,
    alignItems: 'center',
    gap: space.sm,
  },
  // Brand spec: sharp 52×52 brass square, no rounded corners, no
  // Material drop shadow. Contrast with the cream canvas is the only
  // affordance; a soft elevation would betray the brand restraint.
  peepholeRow: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  fabPrimary: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabPlus: {
    fontFamily: font.bold,
    fontSize: 26,
    lineHeight: 28,
    includeFontPadding: false,
  },
});
