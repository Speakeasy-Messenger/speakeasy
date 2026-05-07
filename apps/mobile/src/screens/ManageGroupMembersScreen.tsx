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
import { ApiError } from '../api/client.js';
import { api, vouchflow } from '../services.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useColors } from '../theme/index.js';
import { colors, fonts, space, text } from '../theme/index.js';
import { font, type } from '../theme/tokens.js';
import { diag } from '../diag/log.js';

interface Props {
  groupId: string;
  onBack: () => void;
}

/**
 * Manage members of a group — BRANDING1.md §6.6 (sharp buttons), §6.8
 * (ListItem) + §7 (workspace conventions). Two affordances:
 *
 *  - **Add member**: input + Add button. Validates against `isUserId`
 *    so a typo returns inline rather than a 400 from the server.
 *  - **Remove member** (creator only): Per-row "Remove" link, gated by
 *    Alert.alert for the danger confirm (brand §1: no third color for
 *    danger — the dialog is the gate, not a red label).
 *
 * Non-creators see a read-only roster.
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
          <Text style={[styles.backText, { color: themed.primary }]}>‹ Back</Text>
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
            // Brand §2.4: inputs at radius-2 (4px). Single-color border
            // in `divider` keeps the input quiet against the canvas.
            style={[
              styles.input,
              { backgroundColor: themed.cream, color: themed.ink, borderColor: themed.divider },
            ]}
            testID="manage-members-input"
          />
          <Pressable
            onPress={() => void handleAdd()}
            disabled={adding}
            style={[
              styles.addBtn,
              { backgroundColor: themed.primary },
              adding && styles.addBtnDisabled,
            ]}
            testID="manage-members-add"
          >
            <Text style={[styles.addBtnText, { color: themed.cream }]}>
              {adding ? '…' : 'Add'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {loading && members.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={themed.primary} />
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={[text.subtitle, styles.empty, { color: themed.slate }]}>
              No members.
            </Text>
          }
          renderItem={({ item }) => {
            const isCreatorRow = item === createdBy;
            const isSelf = item === myUserId;
            return (
              <View style={[styles.row, { borderBottomColor: themed.divider }]}>
                <View style={styles.rowBody}>
                  <Text style={[styles.rowName, { color: themed.ink }]} numberOfLines={1}>
                    @{item}
                    {isSelf ? ' (you)' : ''}
                  </Text>
                  {isCreatorRow ? (
                    <Text style={[styles.rowSub, { color: themed.slate }]}>
                      CREATOR
                    </Text>
                  ) : null}
                </View>
                {isCreator && !isCreatorRow ? (
                  <Pressable
                    onPress={() => handleRemove(item)}
                    hitSlop={6}
                    testID={`manage-members-remove-${item}`}
                  >
                    <Text style={[styles.removeText, { color: themed.slate }]}>Remove</Text>
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
    paddingBottom: space.md,
  },
  // Brand §2.4: inputs at 4px radius. Hairline border in `divider` —
  // the input reads as "frame around the canvas", not a competing
  // surface.
  input: {
    flex: 1,
    height: 48,
    paddingHorizontal: space.md,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: font.regular,
    fontSize: type.body.size,
  },
  // Brand §6.6 Button (primary): 48 high, 0 radius (sharp,
  // intentional), 12/24 padding, body weight semibold.
  addBtn: {
    height: 48,
    paddingHorizontal: 24,
    justifyContent: 'center',
    borderRadius: 0,
  },
  addBtnDisabled: { opacity: 0.5 },
  addBtnText: { fontFamily: font.semibold, fontSize: type.body.size },

  listContent: { paddingBottom: space.xxl },
  empty: { textAlign: 'center', marginTop: space.lg },

  // Brand §6.8 ListItem: 56 min, 16/20 padding, hairline `text-ghost`
  // bottom border. No card background, no per-row avatar (the brand
  // treats handle-as-identity for list rows; the members roster
  // follows the conversation-list precedent).
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: {
    fontFamily: type.body.weight,
    fontSize: type.body.size,
    letterSpacing: type.body.size * type.body.letterSpacingEm,
  },
  // "CREATOR" rendered in `meta` style — uppercase + accent-tracking
  // matches §2.2's section-label treatment, signalling it's a label
  // about the row, not row content.
  rowSub: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
  // Brand §1: no third color for danger. "Remove" reads as a quiet
  // text-link in slate; the Alert.alert dialog handles the
  // are-you-sure gate. Was '#C44' in the previous design — replaced.
  removeText: { fontFamily: font.medium, fontSize: 13 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
