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
import { useIdentity } from '../store/identity.js';

interface ConversationRow {
  conversationId: string;
  peerUserId: string;
  preview: string;
  /** Wall-clock ms of the last message, or createdAt if empty. */
  sortKey: number;
}

interface Props {
  onOpenChat: (peerUserId: string) => void;
  onNewChat: () => void;
}

/**
 * Phase 5e: real conversations list. Renders every direct conversation
 * known to the local store, sorted by most-recent activity. The "+ New
 * chat" CTA opens [NewChatScreen] which collects a peer ID.
 *
 * Group / community chats not yet listed here — Phase 5e UI follow-up
 * once group/community membership state lives client-side.
 */
export function ConversationsScreen({ onOpenChat, onNewChat }: Props) {
  const userId = useIdentity((s) => s.userId);
  const wsState = useConnection((s) => s.state);
  const byId = useConversations((s) => s.byId);

  const rows: ConversationRow[] = Object.entries(byId)
    .filter(([_, c]) => c.kind === 'direct' && !!c.peerUserId)
    .map(([conversationId, c]) => {
      const last = c.messages[c.messages.length - 1];
      return {
        conversationId,
        peerUserId: c.peerUserId!,
        preview: last?.text ?? '(no messages yet)',
        sortKey: last?.sentAt ?? c.createdAt,
      };
    })
    .sort((a, b) => b.sortKey - a.sortKey);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={[text.sectionLabel, styles.label]}>YOU ARE</Text>
        <Text style={[text.heroBody, styles.you]}>{userId}</Text>
        <Text style={[text.footnote, styles.status]}>connection · {wsState}</Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.conversationId}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <Text style={[text.subtitle, styles.emptyText]}>No conversations yet.</Text>
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpenChat(item.peerUserId)} style={styles.row}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(item.peerUserId)}</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowName} numberOfLines={1}>{item.peerUserId}</Text>
              <Text style={styles.rowPreview} numberOfLines={1}>{item.preview}</Text>
            </View>
          </Pressable>
        )}
      />

      <View style={styles.bottom}>
        <Pressable onPress={onNewChat} style={styles.newBtn}>
          <Text style={styles.newBtnText}>+ New chat</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/**
 * Two-letter initials from a hyphenated id (e.g. silent-golden-hawk → SH).
 * First letter of the first word + first letter of the last word.
 */
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
});
