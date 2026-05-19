import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TtlOption } from '@speakeasy/shared';
import { AppBar } from '../components/AppBar.js';
import { FindSomeoneSheet } from '../components/FindSomeoneSheet.js';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { TTLSegmentedControl } from '../components/TTLSegmentedControl.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { api } from '../services.js';
import { ApiError } from '../api/client.js';
import { diag } from '../diag/log.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

interface Props {
  /** Called after createGroup + member adds succeed. */
  onCreated: (groupId: string) => void;
  onCancel: () => void;
}

const ROOM_NAME_MAX = 30;
const ROOM_MEMBER_CAP = 50;

/**
 * NEW-CONVERSATION.md §4 — Create a room.
 *
 * Three sections (Members / Name / TTL) under a workspace AppBar
 * with a brass `Create` action when the room passes validation.
 * Members are added one at a time via the Find Someone sheet in
 * `add-to-room` mode — no comma-separated paste, no out-of-band
 * handle handling. Default TTL is 24h per spec §4.6 (more
 * aggressive than 1:1's 7d default to compensate for multi-party
 * spread risk).
 *
 * Server contract is preserved from the old screen: `createGroup`
 * mints a room id, then `addGroupMember` per peer. The single-call
 * `POST /v1/rooms/create` from the spec doesn't exist server-side
 * yet; landing the new endpoint is a follow-up.
 */
export function NewGroupScreen({ onCreated, onCancel }: Props) {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  const upsertGroup = useGroups((s) => s.upsert);
  const setTtl = useConversations((s) => s.setTtl);
  const openGroup = useConversations((s) => s.openGroup);

  const [members, setMembers] = useState<readonly string[]>([]);
  const [name, setName] = useState('');
  const [ttl, setTtlValue] = useState<Exclude<TtlOption, 'off'>>('day');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [findOpen, setFindOpen] = useState(false);

  const trimmedName = name.trim();
  const isValid =
    members.length >= 1 &&
    trimmedName.length > 0 &&
    trimmedName.length <= ROOM_NAME_MAX &&
    !busy;

  function addMember(handle: string) {
    setMembers((prev) =>
      prev.includes(handle) || prev.length >= ROOM_MEMBER_CAP
        ? prev
        : [...prev, handle],
    );
  }

  function removeMember(handle: string) {
    setMembers((prev) => prev.filter((m) => m !== handle));
  }

  async function handleCreate() {
    if (!myUserId) {
      setError('Not enrolled.');
      return;
    }
    if (!isValid) return;
    setError(undefined);
    setBusy(true);
    diag('group', 'create: start', {
      name: trimmedName,
      memberCount: members.length,
      ttl,
    });
    try {
      const deviceToken = useIdentity.getState().deviceToken;
      if (!deviceToken) {
        setError('Sign in again — device token missing.');
        return;
      }
      const { group_id } = await api.createGroup(deviceToken, trimmedName);
      for (const member of members) {
        try {
          await api.addGroupMember(deviceToken, group_id, member);
        } catch (memberErr) {
          const e = memberErr as { code?: string; status?: number };
          diag('group', 'create: addGroupMember FAILED', {
            group_id,
            member,
            code: e.code,
            status: e.status,
          });
          throw memberErr;
        }
      }
      upsertGroup({
        id: group_id,
        name: trimmedName,
        members: [myUserId, ...members],
        createdAt: Date.now(),
        createdBy: myUserId,
        metadataFetchedAt: Date.now(),
      });
      // Apply the chosen TTL to the local conversation. The wire
      // broadcast (`POST /v1/rooms/<id>/ttl`) doesn't exist yet, so
      // peers will see their local default until they open the
      // group; this is a known follow-up.
      openGroup(group_id);
      setTtl(group_id, ttl);
      onCreated(group_id);
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string; code?: string; status?: number };
      if (err instanceof ApiError) {
        setError(`Server rejected: ${err.code ?? err.status}`);
      } else {
        setError(e.message ?? 'Couldn’t create the room. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView
      testID="new-group-screen"
      style={[styles.root, { backgroundColor: themed.cream }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        {/* AppBar per spec §4.1: back / title / Create action. */}
        <AppBar
          onBack={onCancel}
          title="New room"
          testID="new-group-appbar"
          trailing={
            <Pressable
              testID="new-group-create"
              onPress={() => void handleCreate()}
              hitSlop={8}
              disabled={!isValid}
            >
              <Text
                style={[
                  styles.createAction,
                  { color: isValid ? themed.primary : themed.slate },
                ]}
              >
                {busy ? 'Creating…' : 'Create'}
              </Text>
            </Pressable>
          }
        />

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* Members ------------------------------------------------- */}
          <View style={[styles.section, { borderBottomColor: themed.divider }]}>
            <Text style={[styles.sectionLabel, { color: themed.slate }]}>
              MEMBERS
            </Text>
            <View>
              {members.map((handle) => (
                <MemberRow
                  key={handle}
                  handle={handle}
                  onRemove={() => removeMember(handle)}
                />
              ))}
              <Pressable
                testID="new-group-add-member"
                onPress={() => setFindOpen(true)}
                style={[styles.addRow, { borderTopColor: themed.divider }]}
              >
                <Text style={[styles.addAt, { color: themed.primary }]}>@</Text>
                <Text style={[styles.addLabel, { color: themed.slate }]}>
                  add another…
                </Text>
              </Pressable>
              <Text
                style={[
                  styles.memberCount,
                  {
                    color:
                      members.length >= ROOM_MEMBER_CAP
                        ? themed.primary
                        : themed.slate,
                  },
                ]}
              >
                {members.length} of {ROOM_MEMBER_CAP}
              </Text>
            </View>
          </View>

          {/* Name --------------------------------------------------- */}
          <View style={[styles.section, { borderBottomColor: themed.divider }]}>
            <Text style={[styles.sectionLabel, { color: themed.slate }]}>
              NAME
            </Text>
            <TextInput
              testID="new-group-name-input"
              value={name}
              onChangeText={(s) => {
                setName(s);
                if (error) setError(undefined);
              }}
              placeholder="thursday-crew"
              placeholderTextColor={themed.slate}
              autoCorrect={false}
              maxLength={ROOM_NAME_MAX}
              returnKeyType="done"
              style={[
                styles.nameInput,
                { color: themed.ink, borderBottomColor: themed.divider },
              ]}
            />
            <Text style={[styles.helper, { color: themed.slate }]}>
              What you and members see. Up to {ROOM_NAME_MAX} characters.
            </Text>
          </View>

          {/* TTL ---------------------------------------------------- */}
          <View style={[styles.section, styles.sectionLast]}>
            <Text style={[styles.sectionLabel, { color: themed.slate }]}>
              MESSAGES LEAVE IN
            </Text>
            <TTLSegmentedControl value={ttl} onChange={setTtlValue} />
            <Text style={[styles.helper, { color: themed.slate }]}>
              Default for new messages. Each message is encrypted and
              disappears after this time.
            </Text>
          </View>

          {error ? (
            <Text
              testID="new-group-error"
              style={[styles.error, { color: themed.primary }]}
            >
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <FindSomeoneSheet
        visible={findOpen}
        onClose={() => setFindOpen(false)}
        mode="add-to-room"
        roomName={trimmedName.length > 0 ? trimmedName : undefined}
        alreadyAddedHandles={members}
        onPickAdd={addMember}
      />
    </SafeAreaView>
  );
}

interface MemberRowProps {
  handle: string;
  onRemove: () => void;
}

function MemberRow({ handle, onRemove }: MemberRowProps): React.ReactElement {
  const themed = useColors();
  const profile = useProfiles((s) => s.byUserId[handle]);
  const animalId = profile?.selectedAvatarId ?? defaultAnimalForUser(handle);
  return (
    <View style={[styles.memberRow, { borderBottomColor: themed.divider }]}>
      <PortraitTile kind="animal" id={animalId} size={28} />
      <View style={styles.memberHandle}>
        <Handle value={handle} variant="body" />
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        testID={`new-group-remove-${handle}`}
      >
        <Text style={[styles.removeLink, { color: themed.slate }]}>remove</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  createAction: {
    fontFamily: font.medium,
    fontSize: 13,
    letterSpacing: 0.4,
  },
  content: { paddingBottom: space.xl },
  section: {
    paddingHorizontal: space.md,
    paddingTop: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionLast: { borderBottomWidth: 0 },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginBottom: space.md,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberHandle: { flex: 1 },
  removeLink: {
    fontFamily: font.regular,
    fontSize: 12,
    letterSpacing: 0.005,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingTop: 12,
    paddingBottom: 4,
    marginTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  addAt: { fontFamily: font.bold, fontSize: 16 },
  addLabel: { fontFamily: font.regular, fontSize: 14 },
  memberCount: {
    fontFamily: font.regular,
    fontSize: 11,
    marginTop: 8,
  },
  // Brass border-bottom (focused colour wired via inline style only
  // when we need it; for MVP the faint divider is enough).
  nameInput: {
    fontFamily: font.bold,
    fontSize: 18,
    letterSpacing: -0.015 * 18,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    marginBottom: 8,
    padding: 0,
  },
  helper: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  error: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
});
