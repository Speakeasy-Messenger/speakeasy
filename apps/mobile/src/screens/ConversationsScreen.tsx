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
import { PhoneIcon } from '../components/icons/CallIcons.js';
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
  /** Open the dialer to start a new call. */
  onOpenDialer?: () => void;
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
  onOpenDialer,
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
          <View style={styles.headerActions}>
            {onOpenDialer ? (
              <Pressable
                onPress={onOpenDialer}
                hitSlop={8}
                style={styles.gearBtn}
                testID="conversations-call-btn"
              >
                <PhoneIcon size={22} />
              </Pressable>
            ) : null}
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
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'direct' ? r.conversationId : r.groupId)}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListHeaderComponent={
          showGetStarted ? (
            <GetStartedCards
              onInviteFriends={onInviteFriends}
              onNewGroup={onNewGroup}
              onNewChat={onNewChat}
            />
          ) : null
        }
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

      <View style={styles.bottom}>
        <Pressable
          testID="conversations-new-chat"
          onPress={onNewChat}
          style={styles.newBtn}
        >
          <Text style={styles.newBtnText}>+ New chat</Text>
        </Pressable>
        <Pressable
          testID="conversations-new-group"
          onPress={onNewGroup}
          style={styles.newGroupBtn}
        >
          <Text style={styles.newGroupBtnText}># New group</Text>
        </Pressable>
      </View>
    </SafeAreaView>
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
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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
  bottom: { padding: space.lg, gap: space.sm },
  newBtn: {
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  newBtnText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 15,
  },
  newGroupBtn: {
    paddingVertical: 12,
    borderRadius: radius.pill,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  newGroupBtnText: {
    color: colors.primary,
    fontFamily: fonts.inter500,
    fontSize: 14,
  },
});
