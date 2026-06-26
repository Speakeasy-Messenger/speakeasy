import React, { useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TtlOption } from '@speakeasy/shared';
import { AppBar } from '../components/AppBar.js';
import { FindSomeoneSheet } from '../components/FindSomeoneSheet.js';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { TTLSegmentedControl } from '../components/TTLSegmentedControl.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { ApiError } from '../api/client.js';
import { api, vouchflow } from '../services.js';
import { getDeviceTokenOrVerify } from '../auth/verify-device.js';
import { diag } from '../diag/log.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { useColors } from '../theme/index.js';
import { font, scrim, space, type as typeScale } from '../theme/tokens.js';

interface Props {
  groupId: string;
  onBack: () => void;
  /** Open a 1:1 with a member — tapping their row in the roster. */
  onOpenPeer?: (handle: string) => void;
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
export function GroupSettingsScreen({ groupId, onBack, onOpenPeer }: Props): React.ReactElement {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  const group = useGroups((s) => s.byId[groupId]);
  const setNameInStore = useGroups((s) => s.setName);
  const setMembers = useGroups((s) => s.setMembers);
  const removeGroupLocal = useGroups((s) => s.remove);
  const addMemberLocal = useGroups((s) => s.addMember);
  const removeMemberLocal = useGroups((s) => s.removeMember);
  const ttl = useConversations((s) => s.byId[groupId]?.ttl ?? 'week');
  const muted = useConversations((s) => !!s.byId[groupId]?.muted);
  const setTtl = useConversations((s) => s.setTtl);
  const setMuted = useConversations((s) => s.setMuted);
  const removeConvo = useConversations((s) => s.removeConversation);

  const [nameSheetOpen, setNameSheetOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | undefined>();
  const [leaveOpen, setLeaveOpen] = useState(false);

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
        <AppBar onBack={onBack} title="Room" testID="group-settings-loading-appbar" />
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

  async function handleSaveName(next: string) {
    setNameSheetOpen(false);
    const previous = group?.name ?? '';
    setNameInStore(groupId, next);
    try {
      const dt = await getDeviceToken();
      const updated = await api.setGroupName(dt, groupId, next);
      if (updated.name) setNameInStore(groupId, updated.name);
    } catch (err) {
      setNameInStore(groupId, previous);
      const msg =
        err instanceof ApiError
          ? `Couldn't rename (${err.code ?? err.status})`
          : `Couldn't rename. ${String(err)}`;
      Alert.alert('Rename failed', msg);
    }
  }

  async function handleLeave() {
    setLeaveOpen(false);
    try {
      const dt = await getDeviceToken();
      await api.leaveGroup(dt, groupId);
      removeConvo(groupId);
      removeGroupLocal(groupId);
      onBack();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `Couldn't leave (${err.code ?? err.status})`
          : `Couldn't leave. ${String(err)}`;
      Alert.alert('Leave failed', msg);
    }
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <AppBar onBack={onBack} title="Room" testID="group-settings-appbar" />

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
              onOpenPeer={undefined}
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
              onOpenPeer={onOpenPeer}
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
              value={!muted}
              onValueChange={(next) => setMuted(groupId, !next)}
              trackColor={{ false: themed.divider, true: themed.primary }}
              thumbColor={!muted ? themed.cream : themed.slate}
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
        onConfirm={() => void handleLeave()}
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
  /** Tap the row (not the remove button) to open a 1:1 with this member. */
  onOpenPeer: ((handle: string) => void) | undefined;
}

function MemberRow({
  handle,
  isSelf,
  isCreator,
  showRemove,
  onRemove,
  onOpenPeer,
}: MemberRowProps): React.ReactElement {
  const themed = useColors();
  const profile = useProfiles((s) => s.byUserId[handle]);
  const animalId = profile?.selectedAvatarId ?? defaultAnimalForUser(handle);
  return (
    // The row opens a 1:1 with this member; the nested "remove" Pressable
    // captures its own taps. Self has no DM target, so it's not pressable.
    <Pressable
      style={[styles.memberRow, { borderBottomColor: themed.divider }]}
      onPress={isSelf ? undefined : () => onOpenPeer?.(handle)}
      disabled={isSelf || !onOpenPeer}
      testID={`group-member-${handle}`}
    >
      <PortraitTile kind="animal" id={animalId} size={32} />
      <View style={styles.memberBody}>
        <View style={styles.memberHandleLine}>
          <Handle value={handle} variant="body" />
          {isSelf ? (
            <Text style={[styles.youSuffix, { color: themed.slate }]}>
              · you
            </Text>
          ) : null}
        </View>
        {isCreator ? (
          <Text style={[styles.creatorBadge, { color: themed.primary }]}>
            CREATOR
          </Text>
        ) : null}
        {/* No presence line for non-creators. This app is concealment-first
            and deliberately doesn't broadcast presence (see PrivacyScreen).
            The list previously hardcoded "offline" for everyone, which read
            like a live — and always-wrong — signal. Show handle/role only
            until real presence is a deliberate product call (spec §3.6). */}
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
    </Pressable>
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
  // Edge-to-edge: clear the nav bar so the sheet buttons aren't behind it.
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(currentName);
  useEffect(() => {
    if (visible) setDraft(currentName);
  }, [visible, currentName]);
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);
  const trimmed = draft.trim();
  const valid =
    trimmed.length > 0 && trimmed.length <= NAME_MAX && trimmed !== currentName;
  if (!visible) return <View testID="name-edit-hidden" />;
  return (
    <View style={styles.sheetOverlay} testID="name-edit-overlay">
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: scrim.modal }]}
        onPress={onClose}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={StyleSheet.absoluteFill}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: themed.cream,
              borderTopColor: themed.divider,
              paddingBottom: insets.bottom + space.xxl,
            },
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
    </View>
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
  // Edge-to-edge: clear the nav bar so the sheet buttons aren't behind it.
  const insets = useSafeAreaInsets();
  // Same inline-overlay pattern as FindSomeoneSheet after rc.30 dropped
  // RN Modal. Native Modal + box-none wrap froze the entire app on
  // Android Samsung One UI dark mode + statusBarTranslucent — same
  // class of bug the FAB freeze hit. User reported the remove button
  // freezes everything; fix is to ditch Modal here too.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);
  if (!visible) return <View testID="remove-member-hidden" />;
  return (
    <View style={styles.sheetOverlay} testID="remove-member-overlay">
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: scrim.modal }]}
        onPress={onClose}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: themed.cream,
            borderTopColor: themed.divider,
            paddingBottom: insets.bottom + space.xxl,
          },
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
  // Edge-to-edge: clear the nav bar so the sheet buttons aren't behind it.
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);
  if (!visible) return <View testID="leave-room-hidden" />;
  return (
    <View style={styles.sheetOverlay} testID="leave-room-overlay">
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: scrim.modal }]}
        onPress={onClose}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: themed.cream,
            borderTopColor: themed.divider,
            paddingBottom: insets.bottom + space.xxl,
          },
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
  return getDeviceTokenOrVerify(vouchflow, 'group_action');
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingBottom: space.xxl },
  header: {
    paddingTop: space.xxl,
    paddingBottom: space.lg,
    paddingHorizontal: space.base,
    alignItems: 'center',
    gap: space.lg,
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
    paddingHorizontal: space.base,
    paddingTop: space.base,
    paddingBottom: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionLast: { borderBottomWidth: 0, paddingTop: space.base, paddingBottom: space.base },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginBottom: space.m,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.s,
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
    gap: space.m,
    paddingVertical: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberBody: { flex: 1, gap: space.xs },
  memberHandleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
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
    gap: space.xs,
    paddingTop: space.m,
    paddingBottom: space.xs,
    marginTop: space.s,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  addAt: { fontFamily: font.bold, fontSize: 16 },
  addLabel: { fontFamily: font.regular, fontSize: 14 },
  helper: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: space.s,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.xs,
  },
  toggleBody: { flex: 1, gap: space.xs },
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
    marginTop: space.xs,
  },
  placeholder: {
    fontFamily: font.regular,
    fontSize: 14,
    padding: space.xl,
    textAlign: 'center',
  },

  // Sheets — shared visual language across all three.
  // sheetScrim / sheetWrap are vestigial (kept for the Save-name sheet
  // which still uses the legacy Modal-wrap pattern) — RemoveMember
  // and LeaveRoom moved to inline-overlay in rc.44 to dodge the same
  // RN-Modal-on-Samsung freeze that hit the FAB in rc.27.
  sheetScrim: { ...StyleSheet.absoluteFillObject },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    elevation: 1000,
    zIndex: 1000,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    paddingTop: space.base,
    paddingBottom: space.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetGrab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginBottom: space.lg,
  },
  sheetTitle: {
    fontFamily: font.bold,
    fontSize: 20,
    letterSpacing: -0.02 * 20,
    marginBottom: space.m,
  },
  sheetBody: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: space.xl,
  },
  sheetInput: {
    fontFamily: font.bold,
    fontSize: 20,
    paddingBottom: space.s,
    borderBottomWidth: 1,
    marginBottom: space.s,
    padding: 0,
  },
  sheetHelper: {
    fontFamily: font.regular,
    fontSize: 11,
    marginBottom: space.xl,
  },
  sheetActions: { gap: space.s },
  btnPrimary: {
    paddingVertical: space.base,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    paddingVertical: space.base,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
