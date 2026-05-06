import React from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Avatar } from '../components/Avatar.js';
import { GetStartedCards } from '../components/GetStartedCards.js';
import { GroupAvatar } from '../components/GroupAvatar.js';
import { StatusSquare } from '../components/StatusSquare.js';
import { SettingsIcon } from '../components/icons/SettingsIcon.js';
import Svg, { Path } from 'react-native-svg';
import { useColors } from '../theme/index.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';
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
 * Phase 5e: combined conversations list — direct chats + groups, sorted
 * by most-recent activity. Spec §14: color-pale cards, rounded-square
 * avatars, timer pills, unread badges, relative timestamps.
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
  // Themed palette — `themed.cream` flips to the light canvas when
  // mode is light. Module-level `styles` (which use the static `colors`
  // alias) stay dark-pinned for now; phase E moves them too.
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
  // Show the Get Started card row while the user has fewer than 5
  // conversations. Cards are individually dismissable; the component
  // renders nothing once everything's been dismissed.
  const showGetStarted = rows.length < 5;

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
              {/* Spec §6.10: status is a 6×6 brass square (online) or
                  text-faint square (offline). The wsState text label is
                  gone — the square IS the status. */}
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
        renderItem={({ item }) =>
          item.kind === 'direct' ? (
            <Pressable onPress={() => onOpenChat(item.peerUserId)} style={[styles.card, { backgroundColor: themed.pale }]}>
              <Avatar userId={item.peerUserId} size={40} />
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text
                    style={[styles.rowName, { color: themed.ink }]}
                    numberOfLines={1}
                  >
                    @{item.peerUserId}
                  </Text>
                  <Text style={[styles.timestamp, { color: themed.slate }]}>
                    {relativeTime(item.lastActivityAt)}
                  </Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text
                    style={[styles.rowPreview, { color: themed.slate }]}
                    numberOfLines={1}
                  >
                    {item.preview}
                  </Text>
                  {item.unread > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{item.unread > 99 ? '99+' : item.unread}</Text>
                    </View>
                  )}
                </View>
              </View>
            </Pressable>
          ) : (
            <Pressable onPress={() => onOpenGroup(item.groupId)} style={[styles.card, { backgroundColor: themed.pale }]}>
              <GroupAvatar groupId={item.groupId} name={item.name} size={40} />
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text
                    style={[styles.rowName, { color: themed.ink }]}
                    numberOfLines={1}
                  >
                    # {item.name}
                  </Text>
                  <Text style={[styles.timestamp, { color: themed.slate }]}>
                    {relativeTime(item.lastActivityAt)}
                  </Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text
                    style={[styles.rowPreview, { color: themed.slate }]}
                    numberOfLines={1}
                  >
                    {item.memberCount} member{item.memberCount === 1 ? '' : 's'} · {item.preview}
                  </Text>
                  {item.unread > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{item.unread > 99 ? '99+' : item.unread}</Text>
                    </View>
                  )}
                </View>
              </View>
            </Pressable>
          )
        }
      />

      {showGetStarted ? (
        <View style={styles.getStartedDock}>
          <GetStartedCards
            onInviteFriends={onInviteFriends}
            onNewGroup={onNewGroup}
            onNewChat={onNewChat}
          />
        </View>
      ) : null}

      <View pointerEvents="box-none" style={styles.fabStack}>
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

function initials(userId: string): string {
  const parts = userId.split('-').filter(Boolean);
  if (parts.length === 0) return '??';
  const first = parts[0]![0]!.toUpperCase();
  const last = parts[parts.length - 1]![0]!.toUpperCase();
  return first + last;
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
  status: { color: colors.slate },
  gearBtn: { padding: space.sm },
  gearIcon: { fontSize: 20 },
  listContent: { paddingHorizontal: space.md, paddingBottom: space.xl, gap: space.xs },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.slate },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.avatar,
    backgroundColor: colors.pale,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.avatar,
    backgroundColor: colors.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: fonts.inter500,
    fontSize: 14,
    color: colors.primary,
    letterSpacing: 0.5,
  },
  avatarGroup: { backgroundColor: colors.primary },
  avatarGroupText: {
    fontFamily: fonts.inter500,
    fontSize: 22,
    color: colors.cream,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rowName: {
    color: colors.ink,
    fontFamily: fonts.inter500,
    fontSize: 14,
    flex: 1,
  },
  timestamp: {
    color: colors.slate,
    fontFamily: fonts.inter300,
    fontSize: 11,
    marginLeft: space.sm,
  },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowPreview: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 12,
    flex: 1,
  },
  badge: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 11,
  },
  // Sticky bottom dock for the Get Started cards. The cards are
  // horizontal-scrollable; the dock is a fixed-height row above the
  // FABs so the chat list always has the rest of the screen.
  getStartedDock: {
    borderTopColor: colors.pale,
    borderTopWidth: 1,
    backgroundColor: colors.cream,
  },
  // FABs float over the bottom-right corner. `pointerEvents="box-none"`
  // on the wrapper lets taps fall through to the list everywhere except
  // on the buttons themselves.
  fabStack: {
    position: 'absolute',
    right: space.lg,
    bottom: space.lg,
    alignItems: 'center',
    gap: space.sm,
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
