import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TtlOption } from '@speakeasy/shared';
import { FindSomeoneSheet } from '../components/FindSomeoneSheet.js';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { StatusSquare } from '../components/StatusSquare.js';
import { TTLSegmentedControl } from '../components/TTLSegmentedControl.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { ApiError } from '../api/client.js';
import { api, vouchflow } from '../services.js';
import { diag } from '../diag/log.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { space, useColors } from '../theme/index.js';
import { font, scrim, type as typeScale } from '../theme/tokens.js';

interface Props {
  groupId: string;
  onBack: () => void;
}

const NAME_MAX = 30;
const ROOM_MEMBER_CAP = 50;

/**
 * GROUP-SETTINGS.md §3 / §4 — full group room settings.
 *
 * Two presentations, one component: creator and member views differ
 * only in which affordances render (Edit on Name, remove links on
 * member rows, "add another…" row, TTL editability). Detection at
 * mount via `createdBy === myUserId`.
 *
 * Server gaps the spec calls out (§10) that are landed UI-only here:
 *   - `/v1/rooms/<id>/name`        — name change is local-only
 *   - `/v1/rooms/<id>/ttl`         — TTL change is local-only
 *   - `/v1/rooms/<id>/leave`       — leave drops the group locally
 *                                    only; peers don't see "@x left."
 * Each is documented inline at the call site.
 */
export function GroupSettingsScreen({ groupId, onBack }: Props): React.ReactElement {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  const group = useGroups((s) => s.byId[groupId]);
  const setNameInStore = useGroups((s) => s.setName);
  const setMembers = useGroups((s) => s.setMembers);
  const removeGroupLocal = useGroups((s) => s.remove);
  const addMemberLocal = useGroups((s) => s.addMember);
  const removeMemberLocal = useGroups((s) => s.removeMember);
  const ttl = useConversations((s) => s.byId[groupId]?.ttl ?? 'day');
  const setTtl = useConversations((s) => s.setTtl);
  const removeConvo = useConversations((s) => s.removeConversation);

  const [nameSheetOpen, setNameSheetOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | undefined>();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [notifyOn, setNotifyOn] = useState(true);

  const isCreator = !!myUserId && !!group?.createdBy && myUserId === group.createdBy;
  const otherMembers = (group?.members ?? []).filter((m) => m !== myUserId);
  const memberCount = group?.members.length ?? 0;

  // Roster refresh: surface authoritative members + creator from
  // server on mount. Same pattern as ManageGroupMembersScreen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dt = await getDeviceToken();
        const r = await api.listGroupMembers(dt, groupId);
        if (cancelled) return;
        setMembers(groupId, r.members);
        if (r.created_by) {
          // Bump the createdBy in case we discovered it for the first time.
          useGroups.getState().upsert({
            id: groupId,
            name: group?.name ?? '',
            members: r.members,
            createdAt: group?.createdAt ?? Date.now(),
            createdBy: r.created_by,
            metadataFetchedAt: Date.now(),
          });
        }
      } catch (err) {
        diag('group-settings', 'roster refresh failed', { err: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // group.* fields are only used inside the upsert; depending on
    // primitives keeps this effect stable across re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, setMembers]);

  if (!group) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
        <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
          <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
            <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
          </Pressable>
          <Text style={[styles.appbarTitle, { color: themed.ink }]}>Room</Text>
          <View style={{ width: 32 }} />
        </View>
        <Text style={[styles.placeholder, { color: themed.slate }]}>
          Room not loaded.
        </Text>
      </SafeAreaView>
    );
  }

  async function handleAddMember(handle: string) {
    if (!group) return;
    addMemberLocal(groupId, handle);
    try {
      const dt = await getDeviceToken();
      await api.addGroupMember(dt, groupId, handle);
    } catch (err) {
      // Roll the local add back on server failure; the spec calls for
      // an inline error message here, but until the screen has an
      // error region we surface the failure via Alert.
      removeMemberLocal(groupId, handle);
      const msg =
        err instanceof ApiError
          ? `Couldn't add (${err.code ?? err.status})`
          : `Couldn't add. ${String(err)}`;
      Alert.alert('Add failed', msg);
    }
  }

  async function handleRemoveMember(handle: string) {
    setRemoveTarget(undefined);
    if (!group) return;
    try {
      const dt = await getDeviceToken();
      await api.removeGroupMember(dt, groupId, handle);
      removeMemberLocal(groupId, handle);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `Couldn't remove (${err.code ?? err.status})`
          : `Couldn't remove. ${String(err)}`;
      Alert.alert('Remove failed', msg);
    }
  }

  function handleSaveName(next: string) {
    setNameSheetOpen(false);
    setNameInStore(groupId, next);
    // Wire endpoint: `POST /v1/rooms/<id>/name`. Doesn't exist yet,
    // so the rename is local-only and won't reach peers until the
    // server-side broadcast lands. Documented as a follow-up.
  }

  function handleLeave() {
    setLeaveOpen(false);
    // Wire endpoint: `POST /v1/rooms/<id>/leave`. Server-side leave
    // (with successor transfer + `@x left.` system message) isn't
    // implemented yet. We drop the group from local state so the
    // user gets the expected "I'm out of this room" UX; peers will
    // continue to see the local user as a member until the real
    // endpoint lands. Documented in the §10 follow-up list.
    removeConvo(groupId);
    removeGroupLocal(groupId);
    onBack();
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back} testID="group-settings-back">
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.appbarTitle, { color: themed.ink }]}>Room</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Header per §3.3 — large room mark + name + meta. */}
        <View style={[styles.header, { borderBottomColor: themed.divider }]}>
          <PortraitTile kind="room" id={groupId} size={88} />
          <Text style={[styles.headerName, { color: themed.ink }]} numberOfLines={1}>
            {group.name}
          </Text>
          <Text style={[styles.headerMeta, { color: themed.slate }]}>
            {memberCount} IN THE ROOM · LEAVES IN {ttlLabel(ttl)}
          </Text>
        </View>

        {/* NAME --------------------------------------------------- */}
        <View style={[styles.section, { borderBottomColor: themed.divider }]}>
          <Text style={[styles.sectionLabel, { color: themed.slate }]}>NAME</Text>
          <View style={styles.nameRow}>
            <Text
              style={[styles.nameText, { color: themed.ink }]}
              numberOfLines={1}
            >
              {group.name}
            </Text>
            {isCreator ? (
              <Pressable
                onPress={() => setNameSheetOpen(true)}
                hitSlop={8}
                testID="group-settings-edit-name"
              >
                <Text style={[styles.editLink, { color: themed.primary }]}>
                  Edit
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* MEMBERS ------------------------------------------------ */}
        <View style={[styles.section, { borderBottomColor: themed.divider }]}>
          <View style={styles.sectionLabelRow}>
            <Text style={[styles.sectionLabel, { color: themed.slate }]}>
              MEMBERS
            </Text>
            <Text
              style={[
                styles.sectionLabel,
                {
                  color:
                    memberCount >= ROOM_MEMBER_CAP
                      ? themed.primary
                      : themed.ink,
                },
              ]}
            >
              {memberCount} OF {ROOM_MEMBER_CAP}
            </Text>
          </View>

          {myUserId ? (
            <MemberRow
              handle={myUserId}
              isSelf
              isCreator={isCreator}
              showRemove={false}
              onRemove={undefined}
            />
          ) : null}
          {otherMembers.map((handle) => (
            <MemberRow
              key={handle}
              handle={handle}
              isSelf={false}
              isCreator={!!group.createdBy && handle === group.createdBy}
              showRemove={isCreator}
              onRemove={() => setRemoveTarget(handle)}
            />
          ))}

          {isCreator ? (
            <Pressable
              onPress={() => setFindOpen(true)}
              style={[styles.addRow, { borderTopColor: themed.divider }]}
              testID="group-settings-add-member"
            >
              <Text style={[styles.addAt, { color: themed.primary }]}>@</Text>
              <Text style={[styles.addLabel, { color: themed.slate }]}>
                add another…
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* TTL ---------------------------------------------------- */}
        <View style={[styles.section, { borderBottomColor: themed.divider }]}>
          <Text style={[styles.sectionLabel, { color: themed.slate }]}>
            MESSAGES LEAVE IN
          </Text>
          <TTLSegmentedControl
            value={ttl === 'off' ? 'week' : ttl}
            onChange={(next) => isCreator && setTtl(groupId, next)}
            disabled={!isCreator}
          />
          <Text style={[styles.helper, { color: themed.slate }]}>
            {isCreator
              ? 'Changing this affects new messages only. Messages already sent keep their original timer.'
              : 'Only the creator can change this.'}
          </Text>
        </View>

        {/* NOTIFICATIONS ----------------------------------------- */}
        <View style={[styles.section, { borderBottomColor: themed.divider }]}>
          <Text style={[styles.sectionLabel, { color: themed.slate }]}>
            NOTIFICATIONS
          </Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleBody}>
              <Text style={[styles.toggleName, { color: themed.ink }]}>
                Notify on new message
              </Text>
              <Text style={[styles.toggleDesc, { color: themed.slate }]}>
                When the app is closed.
              </Text>
            </View>
            <Switch
              value={notifyOn}
              onValueChange={setNotifyOn}
              trackColor={{ false: themed.divider, true: themed.primary }}
              thumbColor={notifyOn ? themed.cream : themed.slate}
            />
          </View>
        </View>

        {/* DANGER ------------------------------------------------- */}
        <View style={[styles.section, styles.sectionLast]}>
          <Pressable
            onPress={() => setLeaveOpen(true)}
            testID="group-settings-leave"
          >
            <Text style={[styles.dangerName, { color: themed.primary }]}>
              Leave the room
            </Text>
            <Text style={[styles.dangerDesc, { color: themed.slate }]}>
              {isCreator
                ? "You'll lose access to new messages. The creator role will pass to the next member."
                : "You'll lose access to new messages."}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* Sheets ------------------------------------------------- */}
      <FindSomeoneSheet
        visible={findOpen}
        onClose={() => setFindOpen(false)}
        mode="add-to-room"
        roomName={group.name}
        alreadyAddedHandles={group.members}
        onPickAdd={(handle) => void handleAddMember(handle)}
      />

      <NameEditSheet
        visible={nameSheetOpen}
        currentName={group.name}
        onClose={() => setNameSheetOpen(false)}
        onSave={handleSaveName}
      />

      <RemoveMemberSheet
        visible={!!removeTarget}
        handle={removeTarget}
        onClose={() => setRemoveTarget(undefined)}
        onConfirm={() => removeTarget && void handleRemoveMember(removeTarget)}
      />

      <LeaveRoomSheet
        visible={leaveOpen}
        roomName={group.name}
        isCreator={isCreator}
        nextCreator={isCreator ? otherMembers[0] : undefined}
        onClose={() => setLeaveOpen(false)}
        onConfirm={handleLeave}
      />
    </SafeAreaView>
  );
}

interface MemberRowProps {
  handle: string;
  isSelf: boolean;
  isCreator: boolean;
  showRemove: boolean;
  onRemove: (() => void) | undefined;
}

function MemberRow({
  handle,
  isSelf,
  isCreator,
  showRemove,
  onRemove,
}: MemberRowProps): React.ReactElement {
  const themed = useColors();
  const profile = useProfiles((s) => s.byUserId[handle]);
  const animalId = profile?.selectedAvatarId ?? defaultAnimalForUser(handle);
  return (
    <View style={[styles.memberRow, { borderBottomColor: themed.divider }]}>
      <PortraitTile kind="animal" id={animalId} size={32} />
      <View style={styles.memberBody}>
        <View style={styles.memberHandleLine}>
          <Handle value={handle} variant="body" />
          {isSelf ? (
            <Text style={[styles.youSuffix, { color: themed.slate }]}>
              · you
            </Text>
          ) : (
            <StatusSquare variant="offline" />
          )}
        </View>
        {isCreator ? (
          <Text style={[styles.creatorBadge, { color: themed.primary }]}>
            CREATOR
          </Text>
        ) : (
          <Text style={[styles.memberStatusLine, { color: themed.slate }]}>
            {/* Presence isn't tracked client-side yet — assume offline.
                When presence wires up (per spec §3.6) flip these to
                "in the room" for online + "last in Xh ago" for offline
                with a known last-seen. */}
            offline
          </Text>
        )}
      </View>
      {showRemove && onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          testID={`group-settings-remove-${handle}`}
        >
          <Text style={[styles.removeLink, { color: themed.slate }]}>
            remove
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Sheets ───────────────────────────────────────────────────────

interface NameEditSheetProps {
  visible: boolean;
  currentName: string;
  onClose: () => void;
  onSave: (next: string) => void;
}

function NameEditSheet({
  visible,
  currentName,
  onClose,
  onSave,
}: NameEditSheetProps): React.ReactElement {
  const themed = useColors();
  const [draft, setDraft] = useState(currentName);
  useEffect(() => {
    if (visible) setDraft(currentName);
  }, [visible, currentName]);
  const trimmed = draft.trim();
  const valid =
    trimmed.length > 0 && trimmed.length <= NAME_MAX && trimmed !== currentName;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.sheetScrim, { backgroundColor: scrim.modal }]}
        onPress={onClose}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetWrap}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.sheet,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
        >
          <View style={[styles.sheetGrab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.sheetTitle, { color: themed.ink }]}>
            Edit name<Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={currentName}
            placeholderTextColor={themed.slate}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={NAME_MAX + 8 /* allow over-cap entry to trigger error */}
            style={[
              styles.sheetInput,
              {
                color: themed.ink,
                borderBottomColor:
                  trimmed.length > NAME_MAX ? themed.primary : themed.divider,
              },
            ]}
            testID="name-edit-input"
          />
          <Text
            style={[
              styles.sheetHelper,
              {
                color:
                  trimmed.length > NAME_MAX ? themed.primary : themed.slate,
              },
            ]}
          >
            {trimmed.length > NAME_MAX
              ? `${trimmed.length - NAME_MAX} too many.`
              : `Up to ${NAME_MAX} characters.`}
          </Text>
          <View style={styles.sheetActions}>
            <Pressable
              onPress={onClose}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={() => valid && onSave(trimmed)}
              disabled={!valid}
              style={[
                styles.btnPrimary,
                {
                  backgroundColor: valid ? themed.primary : themed.divider,
                },
              ]}
              testID="name-edit-save"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Save
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

interface RemoveMemberSheetProps {
  visible: boolean;
  handle: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
}

function RemoveMemberSheet({
  visible,
  handle,
  onClose,
  onConfirm,
}: RemoveMemberSheetProps): React.ReactElement {
  const themed = useColors();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.sheetScrim, { backgroundColor: scrim.modal }]}
        onPress={onClose}
      />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
        >
          <View style={[styles.sheetGrab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.sheetTitle, { color: themed.ink }]}>
            Remove <Text style={{ color: themed.primary }}>@</Text>
            {handle}
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <Text style={[styles.sheetBody, { color: themed.slate }]}>
            <Text style={{ color: themed.ink, fontFamily: font.medium }}>
              They won't see new messages here.
            </Text>{' '}
            They can be re-added later.
            {'\n\n'}
            Messages they've already received stay on their device until the
            timer runs out — Speakeasy can't reach into someone's phone to
            delete what's already there.
          </Text>
          <View style={styles.sheetActions}>
            <Pressable
              onPress={onClose}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
              testID="remove-member-confirm"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Remove
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface LeaveRoomSheetProps {
  visible: boolean;
  roomName: string;
  isCreator: boolean;
  nextCreator: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
}

function LeaveRoomSheet({
  visible,
  roomName,
  isCreator,
  nextCreator,
  onClose,
  onConfirm,
}: LeaveRoomSheetProps): React.ReactElement {
  const themed = useColors();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.sheetScrim, { backgroundColor: scrim.modal }]}
        onPress={onClose}
      />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
        >
          <View style={[styles.sheetGrab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.sheetTitle, { color: themed.ink }]}>
            Leave {roomName}
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <Text style={[styles.sheetBody, { color: themed.slate }]}>
            You'll lose access to new messages.
            {isCreator && nextCreator ? (
              <>
                {'\n\n'}
                Since you're the creator, the role will pass to{' '}
                <Text style={{ color: themed.ink, fontFamily: font.medium }}>
                  <Text style={{ color: themed.primary }}>@</Text>
                  {nextCreator}
                </Text>{' '}
                — the next member who joined.
              </>
            ) : null}
          </Text>
          <View style={styles.sheetActions}>
            <Pressable
              onPress={onClose}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Stay
              </Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
              testID="leave-room-confirm"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Leave
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Helpers ────────────────────────────────────────────────────

function ttlLabel(t: TtlOption): string {
  switch (t) {
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
  }
}

async function getDeviceToken(): Promise<string> {
  const cached = useIdentity.getState().deviceToken;
  if (cached) return cached;
  const r = await vouchflow.verify({ context: 'login' });
  useIdentity.getState().setDeviceToken(r.deviceToken);
  return r.deviceToken;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  back: { width: 32, paddingVertical: 4 },
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  appbarTitle: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
  },
  body: { paddingBottom: space.xl },
  header: {
    paddingTop: 28,
    paddingBottom: 20,
    paddingHorizontal: space.md,
    alignItems: 'center',
    gap: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerName: {
    fontFamily: font.bold,
    fontSize: 22,
    letterSpacing: -0.02 * 22,
    marginTop: -2,
  },
  headerMeta: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
  },
  section: {
    paddingHorizontal: space.md,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionLast: { borderBottomWidth: 0, paddingTop: 14, paddingBottom: 14 },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  nameText: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: -0.01 * typeScale.subtitle.size,
  },
  editLink: { fontFamily: font.medium, fontSize: 13 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberBody: { flex: 1, gap: 1 },
  memberHandleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  youSuffix: {
    fontFamily: font.regular,
    fontSize: 11,
  },
  creatorBadge: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9,
    letterSpacing: 0.2 * 9,
    textTransform: 'uppercase',
  },
  memberStatusLine: {
    fontFamily: font.regular,
    fontSize: 10.5,
  },
  removeLink: { fontFamily: font.regular, fontSize: 12 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingTop: 12,
    paddingBottom: 4,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  addAt: { fontFamily: font.bold, fontSize: 16 },
  addLabel: { fontFamily: font.regular, fontSize: 14 },
  helper: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  toggleBody: { flex: 1, gap: 2 },
  toggleName: {
    fontFamily: font.medium,
    fontSize: 14,
  },
  toggleDesc: {
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  dangerName: { fontFamily: font.medium, fontSize: 14 },
  dangerDesc: {
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 2,
  },
  placeholder: {
    fontFamily: font.regular,
    fontSize: 14,
    padding: space.lg,
    textAlign: 'center',
  },

  // Sheets — shared visual language across all three.
  sheetScrim: { ...StyleSheet.absoluteFillObject },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetGrab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginBottom: 18,
  },
  sheetTitle: {
    fontFamily: font.bold,
    fontSize: 20,
    letterSpacing: -0.02 * 20,
    marginBottom: 10,
  },
  sheetBody: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 22,
  },
  sheetInput: {
    fontFamily: font.bold,
    fontSize: 20,
    paddingBottom: 6,
    borderBottomWidth: 1,
    marginBottom: 8,
    padding: 0,
  },
  sheetHelper: {
    fontFamily: font.regular,
    fontSize: 11,
    marginBottom: 22,
  },
  sheetActions: { gap: 8 },
  btnPrimary: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
