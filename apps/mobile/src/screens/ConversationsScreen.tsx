import React from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
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
}
interface GroupRow {
  kind: 'group';
  groupId: string;
  name: string;
  memberCount: number;
  preview: string;
  sortKey: number;
}
type Row = DirectRow | GroupRow;

interface Props {
  onOpenChat: (peerUserId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  onOpenDiagnostics: () => void;
}

/**
 * Phase 5e: combined conversations list — direct chats + groups, sorted
 * by most-recent activity. Groups render with a `#` prefix per spec §14
 * so they're trivially distinguishable from a peer id.
 */
export function ConversationsScreen({
  onOpenChat,
  onOpenGroup,
  onNewChat,
  onNewGroup,
  onOpenDiagnostics,
}: Props) {
  const userId = useIdentity((s) => s.userId);
  const wsState = useConnection((s) => s.state);
  const conversationsById = useConversations((s) => s.byId);
  const groupsById = useGroups((s) => s.byId);

  const directRows: DirectRow[] = Object.entries(conversationsById)
    .filter(([_, c]) => c.kind === 'direct' && !!c.peerUserId)
    .map(([conversationId, c]) => {
      const last = c.messages[c.messages.length - 1];
      return {
        kind: 'direct' as const,
        conversationId,
        peerUserId: c.peerUserId!,
        preview: last?.text ?? '(no messages yet)',
        sortKey: last?.sentAt ?? c.createdAt,
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
      preview: last?.text ?? '(no messages yet)',
      sortKey: last?.sentAt ?? g.createdAt,
    };
  });

  const rows: Row[] = [...directRows, ...groupRows].sort((a, b) => b.sortKey - a.sortKey);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={[text.sectionLabel, styles.label]}>YOU ARE</Text>
        <Text style={[text.heroBody, styles.you]}>{userId}</Text>
        <Pressable onPress={onOpenDiagnostics} hitSlop={8}>
          <Text style={[text.footnote, styles.status]}>
            connection · {wsState} · tap for diagnostics
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'direct' ? r.conversationId : r.groupId)}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <Text style={[text.subtitle, styles.emptyText]}>No conversations yet.</Text>
        }
        renderItem={({ item }) =>
          item.kind === 'direct' ? (
            <Pressable onPress={() => onOpenChat(item.peerUserId)} style={styles.row}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(item.peerUserId)}</Text>
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowName} numberOfLines={1}>{item.peerUserId}</Text>
                <Text style={styles.rowPreview} numberOfLines={1}>{item.preview}</Text>
              </View>
            </Pressable>
          ) : (
            <Pressable onPress={() => onOpenGroup(item.groupId)} style={styles.row}>
              <View style={[styles.avatar, styles.avatarGroup]}>
                <Text style={styles.avatarGroupText}>#</Text>
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowName} numberOfLines={1}>
                  # {item.name}
                </Text>
                <Text style={styles.rowPreview} numberOfLines={1}>
                  {item.memberCount} member{item.memberCount === 1 ? '' : 's'} · {item.preview}
                </Text>
              </View>
            </Pressable>
          )
        }
      />

      <View style={styles.bottom}>
        <Pressable onPress={onNewChat} style={styles.newBtn}>
          <Text style={styles.newBtnText}>+ New chat</Text>
        </Pressable>
        <Pressable onPress={onNewGroup} style={styles.newGroupBtn}>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.chatListBg },
  header: { gap: space.xs, padding: space.lg, paddingBottom: space.md },
  label: { color: colors.slate },
  you: { color: colors.ink, fontFamily: fonts.inter500 },
  status: { color: colors.slate },
  listContent: { paddingHorizontal: space.md, paddingBottom: space.xl, gap: space.xs },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.slate },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.avatar,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.avatar,
    backgroundColor: colors.pale,
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
  rowName: {
    color: colors.ink,
    fontFamily: fonts.inter500,
    fontSize: 14,
  },
  rowPreview: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 12,
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
