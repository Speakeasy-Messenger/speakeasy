import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { GetStartedCards } from '../components/GetStartedCards.js';
import { StatusSquare } from '../components/StatusSquare.js';
import { SettingsIcon } from '../components/icons/SettingsIcon.js';
import Svg, { Path } from 'react-native-svg';
import { useColors } from '../theme/index.js';
import { colors, fonts, space, text } from '../theme/index.js';
import { font, type } from '../theme/tokens.js';
import { useConnection } from '../store/connection.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';

interface DirectRow {
  kind: 'direct';
  conversationId: string;
  peerUserId: string;
  preview: string;
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
  sortKey: number;
  unread: number;
  lastActivityAt: number;
}
type Row = DirectRow | GroupRow;

interface Props {
  onOpenChat: (peerUserId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onInviteFriends: () => void;
}

/**
 * Combined conversations list — direct chats + groups, sorted by most-
 * recent activity. Brand §7 (workspace): flat ListItems with a hairline
 * `text-ghost` divider, no avatars, timestamp on long-press only.
 * Trailing accent indicator marks unread rows (brand §6.8).
 */
export function ConversationsScreen({
  onOpenChat,
  onOpenGroup,
  onNewChat,
  onNewGroup,
  onOpenSettings,
  onInviteFriends,
}: Props) {
  const userId = useIdentity((s) => s.userId);
  const wsState = useConnection((s) => s.state);
  const conversationsById = useConversations((s) => s.byId);
  const groupsById = useGroups((s) => s.byId);
  const unreadCountFor = useConversations((s) => s.unreadCountFor);
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
      sortKey: last?.sentAt ?? g.createdAt,
      unread: conv ? unreadCountFor(groupId) : 0,
      lastActivityAt: last?.sentAt ?? g.createdAt,
    };
  });

  const rows: Row[] = [...directRows, ...groupRows].sort((a, b) => b.sortKey - a.sortKey);
  const showGetStarted = rows.length < 5;

  // The brand spec hides timestamps by default and reveals on
  // long-press (§7). Track which row id is currently revealed; clear
  // after a short window so the row reverts to its quiet default.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerLeft}>
            <Text style={[text.sectionLabel, styles.label, { color: themed.slate }]}>YOU ARE</Text>
            <View style={styles.youRow}>
              <Text
                testID="conversations-userid"
                style={[text.heroBody, styles.you, { color: themed.ink }]}
              >
                @{userId}
              </Text>
              <StatusSquare variant={wsState === 'authed' ? 'online' : 'offline'} />
            </View>
          </View>
          <Pressable
            onPress={onOpenSettings}
            hitSlop={8}
            style={styles.gearBtn}
            testID="conversations-settings-btn"
          >
            <SettingsIcon size={24} />
          </Pressable>
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'direct' ? r.conversationId : r.groupId)}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <Text style={[text.subtitle, styles.emptyText, { color: themed.slate }]}>
            No conversations yet.
          </Text>
        }
        renderItem={({ item }) => {
          const id = item.kind === 'direct' ? item.conversationId : item.groupId;
          const title = item.kind === 'direct' ? `@${item.peerUserId}` : `# ${item.name}`;
          const subtitle =
            item.kind === 'direct'
              ? item.preview
              : `${item.memberCount} member${item.memberCount === 1 ? '' : 's'} · ${item.preview}`;
          const onPress = () =>
            item.kind === 'direct' ? onOpenChat(item.peerUserId) : onOpenGroup(item.groupId);
          const showTimestamp = revealedId === id;
          return (
            <Pressable
              onPress={onPress}
              onLongPress={() => reveal(id)}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: themed.divider },
                pressed && { backgroundColor: themed.soft },
              ]}
            >
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: themed.ink }]} numberOfLines={1}>
                  {title}
                </Text>
                <Text style={[styles.rowSubtitle, { color: themed.slate }]} numberOfLines={1}>
                  {subtitle}
                </Text>
                {showTimestamp ? (
                  <Text
                    style={[
                      styles.rowTimestamp,
                      { color: themed.slate },
                    ]}
                  >
                    {relativeTime(item.lastActivityAt).toUpperCase()}
                  </Text>
                ) : null}
              </View>
              {item.unread > 0 ? (
                <View style={styles.unread}>
                  {item.unread > 1 ? (
                    <Text style={[styles.unreadCount, { color: themed.primary }]}>
                      {item.unread > 99 ? '99+' : item.unread}
                    </Text>
                  ) : null}
                  <View style={[styles.unreadMark, { backgroundColor: themed.primary }]} />
                </View>
              ) : null}
            </Pressable>
          );
        }}
      />

      {showGetStarted ? (
        <View style={[styles.getStartedDock, { backgroundColor: themed.cream, borderTopColor: themed.divider }]}>
          <GetStartedCards
            onInviteFriends={onInviteFriends}
            onNewGroup={onNewGroup}
            onNewChat={onNewChat}
          />
        </View>
      ) : null}

      <View
        pointerEvents="box-none"
        style={[
          styles.fabStack,
          showGetStarted ? styles.fabStackAboveDock : null,
        ]}
      >
        <Pressable
          testID="conversations-new-group"
          onPress={onNewGroup}
          style={[styles.fabSecondary, { backgroundColor: themed.pale }]}
          android_ripple={{ color: themed.soft, borderless: false }}
        >
          <HashFabIcon color={themed.primary} />
        </Pressable>
        <Pressable
          testID="conversations-new-chat"
          onPress={onNewChat}
          style={[styles.fabPrimary, { backgroundColor: themed.primary }]}
          android_ripple={{ color: themed.soft, borderless: false }}
        >
          <PencilFabIcon color={themed.cream} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function PencilFabIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 21 L3 17 L15 5 L19 9 L7 21 Z M14 6 L18 10"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      />
    </Svg>
  );
}

function HashFabIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 9 H21 M3 15 H19 M9 3 L7 21 M17 3 L15 21"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="square"
      />
    </Svg>
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
  header: { gap: space.xs, padding: space.lg, paddingBottom: space.md },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerLeft: { gap: space.xs, flex: 1 },
  label: { color: colors.slate },
  you: { color: colors.ink, fontFamily: fonts.inter500 },
  youRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  gearBtn: { padding: space.sm },
  // Per BRANDING1.md §6.8: 56-min height, 16/20 padding, 1px text-ghost
  // bottom border, NO per-row card background, NO avatar, NO default
  // timestamp. The whole list reads as one quiet column.
  listContent: { paddingBottom: space.xl },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.slate },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: {
    fontFamily: type.body.weight,
    fontSize: type.body.size,
    letterSpacing: type.body.size * type.body.letterSpacingEm,
  },
  rowSubtitle: {
    fontFamily: type.caption.weight,
    fontSize: type.caption.size,
    letterSpacing: type.caption.size * type.caption.letterSpacingEm,
  },
  // Long-press reveal — meta-style timestamp slid in beneath the
  // subtitle. Uppercase + accent-tracking matches the brand's `meta`
  // scale (§2.2) so it reads as a quiet annotation, not a competing
  // line of content.
  rowTimestamp: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  // Trailing accent indicator: a 6×6 brass square (matches §6.10
  // status-square geometry) marks unread rows. When the count is >1,
  // the number appears in `caption`-sized brass to the left of the
  // square. count==1 renders the square alone — minimum information,
  // maximum brand-quiet.
  unread: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginLeft: space.md,
  },
  unreadCount: {
    fontFamily: font.medium,
    fontSize: type.caption.size,
  },
  unreadMark: {
    width: 6,
    height: 6,
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
  fabStackAboveDock: {
    bottom: 156,
  },
  fabPrimary: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  fabSecondary: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
});
