import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AbuseReportReason, TtlOption } from '@speakeasy/shared';
import { conversationIdForDirect, newMessageId } from '@speakeasy/shared';
import { AppBar } from '../components/AppBar.js';
import { BlockConfirmSheet, UnblockConfirmSheet } from '../components/BlockSheets.js';
import { BurnConfirmSheet } from '../components/BurnConfirmSheet.js';
import { ReportConfirmSheet } from '../components/ReportSheets.js';
import { ApiError } from '../api/client.js';
import { api } from '../services.js';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { TTLSegmentedControl } from '../components/TTLSegmentedControl.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { useBlocks } from '../store/blocks.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { useUiState } from '../store/ui.js';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';
import { diag, diagFingerprint } from '../diag/log.js';

interface Props {
  peerId: string;
  onBack: () => void;
}

/**
 * BLOCK.md §3 + CONVERSATIONS.md §3.2 — Conversation Settings.
 *
 * Reached via tapping the AppBar title block in a 1:1 chat. Three
 * sections per the block-flow sketch:
 *   - NOTIFICATIONS: per-conversation Mute toggle
 *   - CONVERSATION: TTL adjust + Burn this conversation
 *   - DANGER: Block / Unblock @<handle>
 *
 * Replaces the temporary Conversation Settings *sheet* that only
 * surfaced the Block action. The sheet is no longer mounted from
 * ChatScreen.
 */
export function ConversationSettingsScreen({
  peerId,
  onBack,
}: Props): React.ReactElement {
  const themed = useColors();
  const myUserId = useIdentity((s) => s.userId);
  const peerProfile = useProfiles((s) => s.byUserId[peerId]);
  const animalId =
    peerProfile?.selectedAvatarId ?? defaultAnimalForUser(peerId);

  const conversationId = myUserId
    ? conversationIdForDirect(myUserId, peerId)
    : '';

  const ttl = useConversations((s) => s.byId[conversationId]?.ttl ?? 'week');
  const muted = useConversations(
    (s) => !!s.byId[conversationId]?.muted,
  );
  const setTtl = useConversations((s) => s.setTtl);
  const setMuted = useConversations((s) => s.setMuted);
  const removeConvo = useConversations((s) => s.removeConversation);
  const addMessage = useConversations((s) => s.add);
  const messageCount = useConversations(
    (s) => s.byId[conversationId]?.messages.length ?? 0,
  );

  const isBlocked = useBlocks((s) => s.isBlocked(peerId));
  const blockUser = useBlocks((s) => s.block);
  const unblockUser = useBlocks((s) => s.unblock);

  const [blockSheetOpen, setBlockSheetOpen] = useState(false);
  const [unblockSheetOpen, setUnblockSheetOpen] = useState(false);
  const [burnSheetOpen, setBurnSheetOpen] = useState(false);
  const [reportSheetOpen, setReportSheetOpen] = useState(false);

  async function handleReportSubmit(
    reason: AbuseReportReason,
    detail?: string,
  ): Promise<void> {
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) {
      // Without a token we can't auth the request — close silently
      // and surface the same generic toast so we don't leak the
      // auth state to a misbehaving caller.
      setReportSheetOpen(false);
      Alert.alert('Report filed', `Thanks. We'll review @${peerId}.`);
      return;
    }
    try {
      await api.reportUser(peerId, { reason, detail }, deviceToken);
      diag('report', 'filed', { peerFp: diagFingerprint(peerId), reason });
    } catch (err) {
      // 404 (handle vanished mid-flight) or 429 (caller spammed
      // reports) are quiet failures from the UI's perspective —
      // showing technical detail leaks the threshold + rate-limit
      // shape. Generic toast either way.
      if (err instanceof ApiError) {
        diag('report', 'api error (suppressed)', { peerFp: diagFingerprint(peerId), status: err.status, code: err.code });
      } else {
        diag('report', 'unknown error (suppressed)', { peerFp: diagFingerprint(peerId), err: String(err) });
      }
    }
    setReportSheetOpen(false);
    Alert.alert('Report filed', `Thanks. We'll review @${peerId}.`);
  }

  function handleBurnConfirm() {
    setBurnSheetOpen(false);
    // BURN.md §5: tag the conversation as dissolving and pop back
    // to the chat surface, where the feed-fade runs. ChatScreen
    // handles the 600ms dissolve + the second goBack to the list.
    // The conversation row itself collapses on the list per §7
    // when ConversationsScreen sees this id in `burningConversationId`.
    useUiState.getState().setBurningConversationId(conversationId);
    // §4.5 / §6: server commit. The endpoint
    // `POST /v1/conversations/<id>/burn` doesn't exist yet; the
    // local dissolve is optimistic per §4.6, so we proceed
    // regardless. When the endpoint lands, fire it here and
    // surface the §4.5 inline error if the server fails.
    diag('burn', 'commit (local-only, server endpoint TODO)', {
      conversationId,
    });
    onBack();
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="conversation-settings-screen"
    >
      <AppBar onBack={onBack} title="Conversation" testID="conv-settings-appbar" />

      <ScrollView contentContainerStyle={styles.body}>
        {/* Header — peer portrait + handle + meta. Mirrors the
            group-settings header but with an animal in place of
            the room mark. */}
        <View style={[styles.header, { borderBottomColor: themed.divider }]}>
          <PortraitTile kind="animal" id={animalId} size={88} />
          <View style={styles.headerHandle}>
            <Handle value={peerId} variant="display" />
          </View>
          <Text style={[styles.headerMeta, { color: themed.slate }]}>
            {isBlocked ? 'BLOCKED' : `E2E · LEAVES IN ${ttlLabel(ttl)}`}
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
                Mute
              </Text>
              <Text style={[styles.toggleDesc, { color: themed.slate }]}>
                Suppress notifications from{' '}
                <Text style={{ color: themed.primary }}>@</Text>
                {peerId}.
              </Text>
            </View>
            <Switch
              value={muted}
              onValueChange={(next) => setMuted(conversationId, next)}
              trackColor={{ false: themed.divider, true: themed.primary }}
              thumbColor={muted ? themed.cream : themed.slate}
              testID="conv-settings-mute"
            />
          </View>
        </View>

        {/* CONVERSATION ------------------------------------------ */}
        <View style={[styles.section, { borderBottomColor: themed.divider }]}>
          <Text style={[styles.sectionLabel, { color: themed.slate }]}>
            CONVERSATION
          </Text>
          <Text style={[styles.subLabel, { color: themed.slate }]}>
            MESSAGES LEAVE IN
          </Text>
          <TTLSegmentedControl
            value={ttl === 'off' ? 'week' : ttl}
            onChange={(next) => setTtl(conversationId, next)}
          />
          <Text style={[styles.helper, { color: themed.slate }]}>
            Changes affect new messages only. Messages already sent keep
            their original timer.
          </Text>

          {/* BURN.md §3.3: brass action color, single-line
              "Dissolves it for both of you. Now." description. The
              row lives in the Conversation section (not Danger) per
              §3.2 — it's destructive but ordinary. */}
          <Pressable
            onPress={() => setBurnSheetOpen(true)}
            style={[styles.burnRow, { borderTopColor: themed.divider }]}
            testID="conv-settings-burn"
          >
            <Text style={[styles.burnLabel, { color: themed.primary }]}>
              Burn this conversation
            </Text>
            <Text style={[styles.burnDesc, { color: themed.slate }]}>
              Dissolves it for both of you. Now.
            </Text>
          </Pressable>
        </View>

        {/* DANGER ------------------------------------------------ */}
        <View style={[styles.section, styles.sectionLast]}>
          <Text style={[styles.sectionLabel, { color: themed.slate }]}>
            DANGER
          </Text>
          <Pressable
            onPress={() =>
              isBlocked ? setUnblockSheetOpen(true) : setBlockSheetOpen(true)
            }
            testID="conv-settings-block"
          >
            <Text style={[styles.dangerName, { color: themed.primary }]}>
              {isBlocked ? 'Unblock' : 'Block'}{' '}
              <Text style={{ color: themed.primary }}>@</Text>
              {peerId}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setReportSheetOpen(true)}
            testID="conv-settings-report"
            style={styles.reportRow}
          >
            <Text style={[styles.dangerName, { color: themed.primary }]}>
              Report <Text style={{ color: themed.primary }}>@</Text>
              {peerId}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      <BurnConfirmSheet
        visible={burnSheetOpen}
        ttl={ttl}
        isDraft={messageCount === 0}
        onClose={() => setBurnSheetOpen(false)}
        onConfirm={handleBurnConfirm}
      />
      <BlockConfirmSheet
        visible={blockSheetOpen}
        handle={peerId}
        onClose={() => setBlockSheetOpen(false)}
        onConfirm={() => {
          setBlockSheetOpen(false);
          blockUser(peerId);
          // BLOCK.md §5.3: append the local-only `you blocked @x.`
          // system message to the blocker's copy of the conversation.
          addMessage(conversationId, {
            id: newMessageId(),
            from: 'system',
            text: `you blocked @${peerId}.`,
            kind: 'direct',
            sentAt: Date.now(),
            stage: 'sent',
          });
          // Pop back to the now-frozen chat so the block takes
          // visible effect immediately.
          onBack();
        }}
      />
      <UnblockConfirmSheet
        visible={unblockSheetOpen}
        handle={peerId}
        onClose={() => setUnblockSheetOpen(false)}
        onConfirm={() => {
          setUnblockSheetOpen(false);
          unblockUser(peerId);
        }}
      />
      <ReportConfirmSheet
        visible={reportSheetOpen}
        handle={peerId}
        onClose={() => setReportSheetOpen(false)}
        onSubmit={handleReportSubmit}
      />
    </SafeAreaView>
  );
}

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

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingBottom: space.xxl },
  header: {
    paddingTop: space.xxl,
    paddingBottom: space.lg,
    paddingHorizontal: space.base,
    alignItems: 'center',
    gap: space.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerHandle: { marginTop: -2 },
  headerMeta: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
  },
  section: {
    paddingHorizontal: space.base,
    paddingTop: space.base,
    paddingBottom: space.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionLast: { borderBottomWidth: 0 },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  subLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    marginBottom: space.m,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  toggleBody: { flex: 1, gap: space.xs },
  toggleName: { fontFamily: font.medium, fontSize: 14 },
  toggleDesc: {
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  helper: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 8,
  },
  burnRow: {
    marginTop: space.base,
    paddingTop: space.base,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  burnLabel: { fontFamily: font.medium, fontSize: 14 },
  burnDesc: {
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: space.xs,
  },
  dangerName: {
    fontFamily: font.medium,
    fontSize: 14,
    paddingVertical: 4,
  },
  reportRow: {
    marginTop: space.s,
  },
});
