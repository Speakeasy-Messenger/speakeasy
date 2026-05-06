import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isUserId } from '@speakeasy/shared';
import { Avatar } from '../components/Avatar.js';
import { ApiError } from '../api/client.js';
import { api, vouchflow } from '../services.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useColors } from '../theme/index.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { diag } from '../diag/log.js';

interface Props {
  groupId: string;
  onBack: () => void;
}

/**
 * Manage members of a group. Two affordances:
 *
 *  - **Add member**: input + Add button, accepts `@handle` or bare
 *    handle. Validates against the same `isUserId` regex used by
 *    NewChat, so a typo returns inline rather than a 400 from the
 *    server. On success the row is appended optimistically and the
 *    local store is updated; the next group send will include the new
 *    member in its fan-out.
 *
 *  - **Remove member** (creator only): Each row has a "Remove" link
 *    on the right. Tapping prompts a confirm dialog, then DELETE
 *    /v1/groups/:id/members/:userId. The creator's own row never gets
 *    a Remove link (server enforces this; we hide it client-side too
 *    so the affordance never tempts).
 *
 * Non-creators see a read-only roster — no Add input, no Remove links.
 *
 * **Sender-key rotation on remove (deferred)**: when a member is
 * kicked, ideally we'd rotate the sender key so the kicked member's
 * still-cached SKDM stops decrypting future messages. The alpha sandbox
 * doesn't enforce post-removal forward secrecy yet — adding rotation is
 * a follow-up; the server already stops fanning messages to the kicked
 * member, so the practical leak window is bounded by what they can
 * coax out of their own previously-cached key, not by ongoing traffic.
 */
export function ManageGroupMembersScreen({ groupId, onBack }: Props) {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  const group = useGroups((s) => s.byId[groupId]);
  const setMembers = useGroups((s) => s.setMembers);
  const removeMemberLocal = useGroups((s) => s.removeMember);
  const addMemberLocal = useGroups((s) => s.addMember);

  const [members, setMembersLocal] = useState<string[]>(group?.members ?? []);
  const [createdBy, setCreatedBy] = useState<string | undefined>(group?.createdBy);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');

  const isCreator = !!myUserId && !!createdBy && myUserId === createdBy;

  // Resync the roster from the server on mount. The local Group.members
  // is an ever-growing union (we never had a remove path before), so it
  // can drift if anyone was kicked; pulling fresh on entry guarantees
  // the manage UI reflects truth.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const dt = await getDeviceToken();
        const r = await api.listGroupMembers(dt, groupId);
        setMembersLocal(r.members);
        setMembers(groupId, r.members);
        setCreatedBy(r.created_by);
      } catch (err) {
        diag('manage-members', 'list failed', { err: String(err) });
      } finally {
        setLoading(false);
      }
    })();
  }, [groupId, setMembers]);

  async function handleAdd() {
    const trimmed = input.trim().replace(/^@/, '');
    if (!trimmed) return;
    if (!isUserId(trimmed)) {
      Alert.alert('Invalid handle', `"${trimmed}" isn't a valid Speakeasy id.`);
      return;
    }
    if (members.includes(trimmed)) {
      Alert.alert('Already a member', `@${trimmed} is already in this group.`);
      return;
    }
    setAdding(true);
    try {
      const dt = await getDeviceToken();
      const r = await api.addGroupMember(dt, groupId, trimmed);
      diag('manage-members', 'added', { groupId, userId: trimmed, members: r.members });
      setMembersLocal((cur) => [...cur, trimmed]);
      addMemberLocal(groupId, trimmed);
      setInput('');
    } catch (err) {
      const code = err instanceof ApiError ? err.code ?? `${err.status}` : String(err);
      Alert.alert('Could not add', code);
    } finally {
      setAdding(false);
    }
  }

  function handleRemove(userId: string) {
    Alert.alert(
      'Remove member?',
      `Remove @${userId} from this group? They won't receive new messages.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void doRemove(userId),
        },
      ],
    );
  }

  async function doRemove(userId: string) {
    try {
      const dt = await getDeviceToken();
      await api.removeGroupMember(dt, groupId, userId);
      diag('manage-members', 'removed', { groupId, userId });
      setMembersLocal((cur) => cur.filter((m) => m !== userId));
      removeMemberLocal(groupId, userId);
    } catch (err) {
      const code = err instanceof ApiError ? err.code ?? `${err.status}` : String(err);
      Alert.alert('Could not remove', code);
    }
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Text style={[styles.backText, { color: colors.primary }]}>← Back</Text>
        </Pressable>
        <Text style={[text.heroBody, { color: themed.ink }]}>Members</Text>
      </View>

      {isCreator ? (
        <View style={styles.addRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="@handle to add"
            placeholderTextColor={themed.slate}
            autoCorrect={false}
            autoCapitalize="none"
            style={[
              styles.input,
              { backgroundColor: themed.pale, color: themed.ink },
            ]}
            testID="manage-members-input"
          />
          <Pressable
            onPress={() => void handleAdd()}
            disabled={adding}
            style={[styles.addBtn, adding && styles.addBtnDisabled]}
            testID="manage-members-add"
          >
            <Text style={styles.addBtnText}>{adding ? '…' : 'Add'}</Text>
          </Pressable>
        </View>
      ) : null}

      {loading && members.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={[text.subtitle, { color: themed.slate, textAlign: 'center', marginTop: space.lg }]}>
              No members.
            </Text>
          }
          renderItem={({ item }) => {
            const isCreatorRow = item === createdBy;
            const isSelf = item === myUserId;
            return (
              <View style={[styles.row, { backgroundColor: themed.pale }]}>
                <Avatar userId={item} size={36} />
                <View style={styles.rowBody}>
                  <Text style={[styles.rowName, { color: themed.ink }]} numberOfLines={1}>
                    @{item}
                    {isSelf ? ' (you)' : ''}
                  </Text>
                  {isCreatorRow ? (
                    <Text style={[styles.rowSub, { color: themed.slate }]}>creator</Text>
                  ) : null}
                </View>
                {isCreator && !isCreatorRow ? (
                  <Pressable
                    onPress={() => handleRemove(item)}
                    hitSlop={6}
                    testID={`manage-members-remove-${item}`}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

async function getDeviceToken(): Promise<string> {
  const cached = useIdentity.getState().deviceToken;
  if (cached) return cached;
  const r = await vouchflow.verify({ context: 'login' });
  useIdentity.getState().setDeviceToken(r.deviceToken);
  return r.deviceToken;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    paddingBottom: space.sm,
  },
  backBtn: { padding: space.xs },
  backText: { fontFamily: fonts.inter500, fontSize: 15 },
  addRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  input: {
    flex: 1,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.pill,
    fontFamily: fonts.inter400,
    fontSize: 14,
  },
  addBtn: {
    paddingHorizontal: space.lg,
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  },
  addBtnDisabled: { opacity: 0.5 },
  addBtnText: { color: colors.cream, fontFamily: fonts.inter500, fontSize: 14 },
  listContent: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.avatar,
  },
  rowBody: { flex: 1 },
  rowName: { fontFamily: fonts.inter500, fontSize: 14 },
  rowSub: { fontFamily: fonts.inter400, fontSize: 11 },
  removeText: { color: '#C44', fontFamily: fonts.inter500, fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
