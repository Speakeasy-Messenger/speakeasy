/**
 * FCM message handlers — v24 correct implementation.
 *
 * CRITICAL: Handlers MUST be registered synchronously at module load.
 * Android Headless JS expects handlers to exist immediately when the
 * bundle loads. Any async/dynamic requires will cause race conditions.
 *
 * rc.83 — peerId resolution moved to consume-time. The background
 * Headless JS context never hydrates the Zustand `conversations`
 * store, so resolving FCM `conversation_id` → `peerUserId` inside
 * `setBackgroundMessageHandler` always falls through to the
 * "use conversation_id as peerId" fallback, persisting a value
 * ChatScreen can't navigate to (it computes
 * `conversationIdForDirect(myUserId, peerId)` and the fallback
 * makes that synthesise a *new* conversation id with no messages
 * → blank screen, tap-does-nothing bug).
 *
 * Fix: persist the raw FCM data instead, and resolve to a peerId
 * at tap-consume time, when the foreground app's store is hydrated.
 * For call taps we additionally check whether the offer is still
 * within ringing window — stale call pushes route to the Chat with
 * the caller instead of an empty IncomingCall screen.
 */

import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import messaging, { FirebaseMessagingTypes } from '@react-native-firebase/messaging';
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AndroidVisibility,
  EventType,
  type Notification,
} from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodePayload, newMessageId } from '@speakeasy/shared';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStack } from '../navigation/RootNavigator.js';
import { useConversations } from '../store/conversations.js';
import { useGroups } from '../store/groups.js';
import { resolveGroupBannerTitle } from './group-banner-title.js';
import { useDistributionIds } from '../store/distribution-ids.js';
import { useSettings } from '../store/settings.js';
import { notifChannelSpec, type NotifKind } from './notif-channels.js';
import { useIdentity } from '../store/identity.js';
import { useCalls } from '../store/calls.js';
import { api, signalProtocol, groupMessaging, getWsClient, peekWsClient } from '../services.js';
import { makeGroupOrchestrator } from '../crypto/group-orchestration.js';
import { b64ToBytes, utf8FromBytes } from '../utils/bytes.js';
import {
  sendReplyMessage,
  sendGroupReplyMessage,
  loadPersistedUserId,
  type ReplySenderDeps,
} from './reply-sender.js';
import { avatarCachePath, cachedAvatarUri } from './avatar-cache.js';
import RNFS from 'react-native-fs';
import { NotifMessaging } from '../native/notif-messaging.js';
import { getCachedDeviceToken } from '../native/cached-device-token.js';
import { shouldSuppressPushForMute } from './push-mute-policy.js';

type RemoteMessage = FirebaseMessagingTypes.RemoteMessage;

// Notification channels are now resolved per-kind from the user's Sound /
// Vibration toggles — see resolveChannel + notif-channels.ts (#10). The
// legacy `speakeasy_default` channel is still pre-created natively in
// MainActivity and remains the native module's hard fallback.

// ---------------------------------------------------------------------------
// FCM data-payload shape
// ---------------------------------------------------------------------------

export type FcmData = {
  conversation_id?: string;
  notify_kind?: 'message' | 'call';
  msg_type?: 'direct' | 'group';
  /** Server-resolved fallback banner copy (privacy-aware). */
  title?: string;
  body?: string;
  /** Buffered message id (for decrypt + de-dup). */
  message_id?: string;
  /** Sender handle — the address the decrypt is keyed on. */
  sender_id?: string;
  /** Message ciphertext (base64). Present only for 'rich' devices on a
   * non-sealed message that fits FCM's payload cap. */
  ciphertext?: string;
};

/**
 * Persisted form of a tapped push. We store the *raw* FCM data plus
 * the timestamp at which the tap was queued — peerId resolution
 * happens at consume time, not here, because the background Headless
 * JS context can't read the (un-hydrated) conversations store.
 */
type PersistedPush = {
  conversationId: string;
  kind: 'message' | 'call';
  msgType: 'direct' | 'group' | undefined;
  /** ms since epoch — used for staleness check on call taps. */
  persistedAt: number;
};

/**
 * Resolved navigation target produced by `resolveTargetAtConsumeTime`.
 * Different from `PersistedPush` because by this point the conversations
 * store is hydrated and we've mapped `conversation_id` → real peerUserId.
 */
type NavTarget =
  | { kind: 'direct'; peerId: string }
  | { kind: 'group'; groupId: string }
  | {
      /**
       * Live incoming call — orchestrator has an `active` call in
       * `incoming_ringing` for this peer, so IncomingCallScreen will
       * render meaningfully. Resolved at consume time only.
       */
      kind: 'call-live';
      conversationId: string;
    }
  | {
      /**
       * Stale call push — by the time the user tapped, the call had
       * already ended / timed out. We route to the Chat with the
       * caller (which shows a "missed call" entry if one was logged)
       * rather than an empty IncomingCallScreen.
       */
      kind: 'call-stale';
      peerId: string;
      conversationId: string;
    }
  | {
      /**
       * Fresh call push tapped BEFORE the WS-delivered offer arrived
       * (the WS was closed for background push routing and is mid cold
       * reconnect — ~4 s on the rc.54 trace). Show IncomingCall in a
       * "Connecting…" state for the peer immediately; it becomes the
       * live incoming call the moment the offer lands (`active`
       * populates). Beats dropping the user in Chat for ~4 s.
       */
      kind: 'call-connecting';
      peerId: string;
      conversationId: string;
    };

const TAP_TARGET_KEY = '@speakeasy/push-tap-target';

/**
 * Queue of inline replies sent from a notification banner, awaiting a
 * hydrated foreground store to be folded into the conversation log.
 */
const PENDING_REPLIES_KEY = '@speakeasy/pending-sent-replies';

/**
 * How long after a call push arrives we still consider it "live" enough
 * to route to IncomingCallScreen. Beyond this we assume the offer
 * expired (orchestrator default ring timeout is ~30 s; we add a small
 * grace for tap latency).
 */
const CALL_STALENESS_MS = 45_000;

async function persistRawPush(p: PersistedPush): Promise<void> {
  try {
    await AsyncStorage.setItem(TAP_TARGET_KEY, JSON.stringify(p));
  } catch {
    // Non-fatal
  }
}

async function consumeRawPush(): Promise<PersistedPush | null> {
  try {
    const val = await AsyncStorage.getItem(TAP_TARGET_KEY);
    if (!val) return null;
    await AsyncStorage.removeItem(TAP_TARGET_KEY);
    const parsed = JSON.parse(val) as Partial<PersistedPush>;
    if (!parsed?.conversationId || !parsed?.kind) return null;
    return {
      conversationId: parsed.conversationId,
      kind: parsed.kind,
      msgType: parsed.msgType,
      persistedAt: typeof parsed.persistedAt === 'number' ? parsed.persistedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * An inline reply sent from a notification, captured for the in-app
 * conversation log. The background headless JS context runs an
 * un-hydrated conversations store, so the reply can't be written
 * straight into it — a persist would clobber the real on-disk
 * history. It's queued here and drained on the next foreground.
 */
type PendingReply = {
  conversationId: string;
  /** Peer handle — used to (re)open the direct conversation (1:1 only). */
  peerId: string;
  messageId: string;
  text: string;
  sentAt: number;
  /** Direct vs group — group echoes land in the group conversation
   * (`byId[groupId]`) instead of an openDirect 1:1. Absent = 'direct'
   * (back-compat with replies queued before group reply existed). */
  msgType?: 'direct' | 'group';
};

async function enqueuePendingReply(p: PendingReply): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_REPLIES_KEY);
    const list: PendingReply[] = raw ? (JSON.parse(raw) as PendingReply[]) : [];
    list.push(p);
    await AsyncStorage.setItem(PENDING_REPLIES_KEY, JSON.stringify(list));
  } catch {
    // Non-fatal — worst case the reply is missing from the in-app log.
  }
}

/**
 * Fold any queued inline replies into the in-app conversation store.
 * No-op until the conversations store is hydrated — draining into an
 * un-hydrated store would persist over the real on-disk history.
 * Safe to call from any foreground entry point; the queue is cleared
 * once consumed.
 */
export async function drainPendingReplies(): Promise<void> {
  if (!useConversations.getState().hydrated) return;
  let list: PendingReply[];
  try {
    const raw = await AsyncStorage.getItem(PENDING_REPLIES_KEY);
    if (!raw) return;
    list = JSON.parse(raw) as PendingReply[];
    await AsyncStorage.removeItem(PENDING_REPLIES_KEY);
  } catch {
    return;
  }
  if (list.length === 0) return;
  const myUserId = await loadPersistedUserId();
  for (const p of list) {
    if (p.msgType === 'group') {
      // Group echo: messages live in `byId[<groupId>]` (the bare id),
      // keyed the same as inbound group messages + the foreground send's
      // optimistic echo. No openDirect — that would mis-file the reply
      // into a 1:1 with the inbound sender.
      const groupId = p.conversationId.replace(/^group-/, '');
      useConversations.getState().add(groupId, {
        id: p.messageId,
        from: 'me',
        text: p.text,
        kind: 'group',
        sentAt: p.sentAt,
        stage: 'sent',
        delivered: false,
      });
      continue;
    }
    // openDirect sets peerUserId (so the row lists) and is idempotent
    // on an existing entry. It returns conversationIdForDirect(...),
    // the same key inbound messages bucket under. Fall back to the
    // FCM conversationId if myUserId is somehow unavailable.
    const cid = myUserId
      ? useConversations.getState().openDirect(myUserId, p.peerId)
      : p.conversationId;
    useConversations.getState().add(cid, {
      id: p.messageId,
      from: 'me',
      text: p.text,
      kind: 'direct',
      sentAt: p.sentAt,
      stage: 'sent',
      // Match ChatScreen's normal outbound bubble state: single check
      // until the server forwards `delivered`, then read receipt can
      // stamp the same wire id.
      delivered: false,
    });
  }
  diag('push-reply', 'drained pending inline replies', { count: list.length });
}

/**
 * Resolve a raw `PersistedPush` (or a fresh cold-start FCM data
 * payload, which we wrap into one) into a navigable target. Runs in
 * the foreground app context where the conversations store is hydrated,
 * so `peerUserId` lookups succeed.
 */
export function resolveTargetAtConsumeTime(p: PersistedPush): NavTarget | null {
  const { conversationId, kind, msgType, persistedAt } = p;
  if (!conversationId || !kind) return null;

  if (kind === 'message') {
    if (msgType === 'group') {
      const groupId = conversationId.replace(/^group-/, '');
      return { kind: 'group', groupId };
    }
    // Direct message — look up peerUserId from hydrated store.
    const conv = useConversations.getState().byId[conversationId];
    if (conv?.peerUserId) {
      return { kind: 'direct', peerId: conv.peerUserId };
    }
    // Store hydrated but no record — likely first-ever message from
    // this peer and the conversation wasn't `openDirect`-created yet.
    // We can't navigate without a real userId (ChatScreen computes
    // conversationIdForDirect(myUserId, peerId)). Bail and let the
    // user open the chat from the conversation list once the WS
    // message arrives and creates the entry.
    diag('push-nav', 'no peerUserId for direct conversation — skipping nav', {
      conversationId,
    });
    return null;
  }

  if (kind === 'call') {
    const conv = useConversations.getState().byId[conversationId];
    const peerId = conv?.peerUserId;
    const ageMs = Date.now() - persistedAt;
    const live = useCalls.getState().active;
    const isLive =
      ageMs < CALL_STALENESS_MS &&
      live?.stage === 'incoming_ringing' &&
      (!peerId || live.peerUserId === peerId);

    if (isLive) {
      return { kind: 'call-live', conversationId };
    }
    if (peerId && ageMs < CALL_STALENESS_MS) {
      // Fresh push, but the offer hasn't arrived over the cold-
      // reconnecting WS yet. This is "connecting", NOT "stale" — show
      // the call screen immediately instead of dropping the user in
      // Chat for the ~4 s the reconnect takes.
      diag('push-nav', 'call push fresh — showing connecting screen', {
        conversationId,
        ageMs,
        liveStage: live?.stage,
      });
      return { kind: 'call-connecting', peerId, conversationId };
    }
    if (peerId) {
      diag('push-nav', 'call push stale — routing to chat instead', {
        conversationId,
        ageMs,
        liveStage: live?.stage,
      });
      return { kind: 'call-stale', peerId, conversationId };
    }
    // Can't even identify the peer → silently drop. The conversation
    // entry will appear once any signaling/message arrives over WS.
    diag('push-nav', 'call push stale + no peerUserId — dropping', {
      conversationId,
      ageMs,
    });
    return null;
  }

  return null;
}

/** Wrap a raw FCM/notifee data payload into a `PersistedPush`. */
function toPersistedPush(data: FcmData): PersistedPush | null {
  if (!data.conversation_id || !data.notify_kind) return null;
  return {
    conversationId: data.conversation_id,
    kind: data.notify_kind,
    msgType: data.msg_type,
    persistedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// NOTIFICATION RENDERING (the app owns display — see notification redesign)
// ---------------------------------------------------------------------------

/**
 * Decrypt the forwarded ciphertext for a message push and return the
 * text to show in the notification. `null` when there's nothing to
 * show. Throws on a decrypt failure — the caller falls back to the
 * server's generic copy.
 *
 * The native decrypt is idempotent (see Android DecryptCache), so
 * running it here does not break the in-app decrypt when the same
 * message later drains over the WebSocket.
 */
async function decryptForNotification(data: FcmData): Promise<string | null> {
  if (!data.ciphertext || !data.sender_id) return null;
  const ciphertext = b64ToBytes(data.ciphertext);
  const plaintext =
    data.msg_type === 'group'
      ? await groupMessaging.decryptFromGroupMember(data.sender_id, ciphertext)
      : await signalProtocol.decrypt(data.sender_id, ciphertext);
  const payload = decodePayload(utf8FromBytes(plaintext));
  // Attachments: don't surface metadata — just "@sender sent an
  // attachment" (title already carries the handle).
  if (payload.attachments && payload.attachments.length > 0) {
    return 'sent an attachment';
  }
  return payload.text ?? null;
}

/** One line in an Android MessagingStyle notification. */
type MsgStyleMsg = {
  text: string;
  timestamp: number;
  /** Sender — omitted means the local user (a sent reply). */
  person?: { id?: string; name: string; icon?: string };
};

/** The local user, for MessagingStyle's required `person`. */
const SELF_PERSON = { id: 'self', name: 'You' };
/** How many recent messages to keep stacked in one notification. */
const MAX_NOTIF_MESSAGES = 6;

/**
 * Create (idempotently) and return the notification channel id that
 * honors the user's Sound + Vibration toggles for this kind (#10).
 * Messages use Sound/Vibration; calls use Ringtone/Vibrate-on-incoming.
 * Each (kind, sound, vibration) combo is its own immutable channel
 * (Android ignores changes to an existing channel) — see notif-channels.ts.
 *
 * Requires `useSettings` hydrated; the headless entry points hydrate it
 * before any display call. Falls back to sound+vibration ON when the
 * store isn't hydrated, matching the historical default.
 */
async function resolveChannel(kind: NotifKind): Promise<string> {
  if (!useSettings.getState().hydrated) {
    await useSettings.getState().hydrate();
  }
  const s = useSettings.getState();
  const sound = kind === 'call' ? s.ringtoneEnabled : s.messageSoundEnabled;
  const vibration = kind === 'call' ? s.vibrateOnIncoming : s.messageVibrationEnabled;
  const spec = notifChannelSpec(kind, sound, vibration);
  // Idempotent — re-creating an existing channel is a no-op. Needed
  // because a headless launch may run before MainActivity created it.
  await notifee.createChannel({ ...spec, importance: AndroidImportance.HIGH });
  return spec.id;
}

/**
 * Pull the stacked MessagingStyle messages off a notification object.
 * Works on both a `getDisplayedNotifications()` entry and the
 * `detail.notification` handed to a notifee event — the latter being
 * the authoritative source mid-reply, when the notification may no
 * longer be in the displayed set.
 */
function messagesFromNotification(notification: Notification | undefined): MsgStyleMsg[] {
  const style = notification?.android?.style;
  if (style && style.type === AndroidStyle.MESSAGING && Array.isArray(style.messages)) {
    return style.messages.map((m) => ({
      text: String(m.text ?? ''),
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
      person: m.person
        ? { id: m.person.id, name: m.person.name, icon: m.person.icon }
        : undefined,
    }));
  }
  return [];
}

/** AsyncStorage key prefix for a conversation's persisted MessagingStyle
 *  stack — see `persistNotifStack`. */
const NOTIF_STACK_PREFIX = '@speakeasy/notif-stack:';

/**
 * Persist a conversation's MessagingStyle stack.
 *
 * The notifee background-event `detail.notification` handed to an inline
 * Reply action does not reliably carry `android.style.messages`. Reading
 * the prior stack back from it dropped the peer's messages, so the reply
 * re-posted a banner containing only the user's own text. This durable
 * copy is the authoritative prior stack for `handleInlineReply`.
 */
async function persistNotifStack(
  conversationId: string,
  messages: MsgStyleMsg[],
): Promise<void> {
  try {
    // Strip the file-URI `icon` — re-derived on the next display.
    const clean = messages.map((m) => ({
      text: m.text,
      timestamp: m.timestamp,
      ...(m.person ? { person: { id: m.person.id, name: m.person.name } } : {}),
    }));
    await AsyncStorage.setItem(
      NOTIF_STACK_PREFIX + conversationId,
      JSON.stringify(clean),
    );
  } catch {
    /* best-effort — handleInlineReply falls back to the event's style */
  }
}

/**
 * Drop a conversation's persisted stack. Call when its notification is
 * cancelled (the user opened/read the chat) so the next message starts a
 * fresh thread instead of re-stacking on already-read messages. The old
 * notifee-backed `existingMessages` reset implicitly (the cancelled
 * notification vanished from getDisplayedNotifications); the durable
 * AsyncStorage stack must be cleared explicitly.
 */
export async function clearNotifStack(conversationId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(NOTIF_STACK_PREFIX + conversationId);
  } catch {
    /* best-effort */
  }
}

/** Read back a conversation's persisted MessagingStyle stack. */
async function loadNotifStack(conversationId: string): Promise<MsgStyleMsg[]> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_STACK_PREFIX + conversationId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MsgStyleMsg[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Render (or update) a conversation's MessagingStyle notification —
 * stacks `messages` and, for 1:1 chats, attaches an inline Reply field.
 */
async function displayMessagingNotification(args: {
  conversationId: string;
  peerHandle: string;
  msgType: string;
  messages: MsgStyleMsg[];
  withReply: boolean;
  /**
   * Banner title. Defaults to the peer handle for 1:1 chats. For groups
   * the caller passes the server-resolved room name (FCM `data.title`)
   * so the notification reads "<Group>" instead of "@sender" — the
   * sender is still shown per-line inside MessagingStyle.
   */
  title?: string;
}): Promise<void> {
  const channel = await resolveChannel('message');
  const myUserId = await loadPersistedUserId();
  // Resolve avatar file paths (not URIs) — the native module loads the
  // bitmaps directly via BitmapFactory.decodeFile, sidestepping the
  // five failed attempts to coax notifee/Fresco into loading a
  // runtime-cached PNG by URI (file://, data:, content://).
  //
  // Two distinct icons for a group (chloro's "double group icon" report):
  //   - CONVERSATION icon (the collapsed banner + the Conversation shortcut)
  //     = the room's own mark, so the thread is identified by the room.
  //   - per-MESSAGE Person icon (shown beside each line when expanded) =
  //     the SENDER's portrait, not the room mark.
  // For 1:1 both are the peer. The group mark is cached under the
  // conversation/group id (GroupMarkCacheWarmer); the sender under their id.
  const peerAvatarPath = await resolveAvatarPath(args.peerHandle);
  const conversationAvatarPath =
    args.msgType === 'group'
      ? await resolveAvatarPath(args.conversationId)
      : peerAvatarPath;
  const selfAvatarPath = myUserId ? await resolveAvatarPath(myUserId) : undefined;
  // Pre-trim the visible stack to MAX_NOTIF_MESSAGES so the persisted
  // copy + the native call see the same set.
  const messages = args.messages.slice(-MAX_NOTIF_MESSAGES);
  // Durable copy of the stack so an inline reply can rebuild the full
  // thread on resend. Awaited (not fire-and-forget): a headless task
  // can be torn down the moment this function resolves, and an
  // unfinished AsyncStorage write left the next reply with an empty
  // stack.
  await persistNotifStack(args.conversationId, messages);
  const latest = messages[messages.length - 1];
  // Banner title resolution:
  //   1:1   → server-resolved "@sender" (data.title) or the handle.
  //   group → the locally-known ROOM name first (authoritative for what the
  //           user sees in-app), then the server title — but only if it
  //           isn't just the sender handle (a stale / mis-resolved push that
  //           labels the whole room by one member, which is what produced
  //           the "@chloro" group banner) — then a neutral label. NEVER the
  //           sender for a group.
  let bannerTitle: string | undefined;
  if (args.msgType === 'group') {
    const groupId = args.conversationId.replace(/^group-/, '');
    const group = useGroups.getState().byId[groupId];
    bannerTitle = resolveGroupBannerTitle(group?.name, args.title, args.peerHandle, {
      members: group?.members,
      selfId: myUserId ?? undefined,
    });
    // The group banner title kept resolving to a member handle / wrong
    // value in the field; this names the exact inputs so the next repro
    // says WHY (missing local name on a non-creator device vs key miss vs
    // a stale server title). groupHit = did this headless store even know
    // the room. (2026-06-05)
    diag('push-bg', 'group banner title resolved', {
      groupId,
      groupHit: !!group,
      localName: group?.name ?? null,
      serverTitle: args.title ?? null,
      sender: args.peerHandle,
      resolved: bannerTitle,
    });
  } else {
    bannerTitle = args.title ?? '@' + args.peerHandle;
  }

  if (NotifMessaging.available()) {
    try {
      const result = await NotifMessaging.display({
        conversationId: args.conversationId,
        channelId: channel,
        peerHandle: args.peerHandle,
        peerAvatarPath: peerAvatarPath ?? null,
        conversationAvatarPath: conversationAvatarPath ?? null,
        selfAvatarPath: selfAvatarPath ?? null,
        withReply: args.withReply,
        title: bannerTitle,
        body: latest?.text ?? 'New message',
        msgType: args.msgType,
        messages: messages.map((m) => ({
          text: m.text,
          timestamp: m.timestamp,
          isFromPeer: !!m.person,
        })),
      });
      diag('push-bg', 'native messaging notification posted', {
        conversationId: args.conversationId,
        peerBitmapLoaded: result?.peerBitmapLoaded ?? false,
        selfBitmapLoaded: result?.selfBitmapLoaded ?? false,
      });
      return;
    } catch (err) {
      diag('push-bg', 'native display failed — falling back to notifee', {
        conversationId: args.conversationId,
        err: String(err),
      });
      // fall through to the notifee path below
    }
  }

  // notifee fallback (iOS, dev builds without the native module).
  // Person icons are still passed as URIs here — known to fall back
  // to the launcher icon on Android, which is why the native path
  // above is the primary one for the messaging notification.
  const peerIconUri = await cachedAvatarUri(args.peerHandle);
  const selfIconUri = myUserId ? await cachedAvatarUri(myUserId) : undefined;
  const selfPerson = {
    ...SELF_PERSON,
    icon: selfIconUri ?? 'ic_notification',
  };
  const styledMessages = messages.map((m) =>
    m.person
      ? {
          ...m,
          person: {
            ...m.person,
            icon: peerIconUri ?? m.person.icon ?? 'ic_notification',
          },
        }
      : m,
  );
  await notifee.displayNotification({
    id: args.conversationId,
    title: bannerTitle,
    body: latest?.text ?? 'New message',
    data: {
      conversation_id: args.conversationId,
      notify_kind: 'message',
      msg_type: args.msgType,
      sender_id: args.peerHandle,
    },
    android: {
      channelId: channel,
      smallIcon: 'ic_notification',
      // No largeIcon — see displayGenericNotification for the
      // rationale. The peer portrait reaches the user via Person.icon
      // inside MessagingStyle, not via a right-side largeIcon tile.
      pressAction: { id: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: selfPerson,
        messages: styledMessages,
      },
      actions: args.withReply
        ? [
            {
              title: 'Reply',
              pressAction: { id: 'reply' },
              input: { allowFreeFormInput: true, placeholder: 'Reply' },
            },
          ]
        : undefined,
    },
  });
}

/**
 * Returns the absolute filesystem path to a userId's cached avatar
 * PNG, or undefined when not cached yet. Used by the native messaging
 * module which decodes the file directly into a Bitmap.
 */
async function resolveAvatarPath(userId: string): Promise<string | undefined> {
  const path = avatarCachePath(userId);
  try {
    return (await RNFS.exists(path)) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Plain single-line notification — private device / sealed / call. */
async function displayGenericNotification(data: FcmData): Promise<void> {
  // Calls honor Ringtone/Vibrate-on-incoming; everything else honors the
  // message Sound/Vibration toggles (#10).
  const channel = await resolveChannel(data.notify_kind === 'call' ? 'call' : 'message');
  // No `largeIcon`. On Samsung One UI and stock Android a largeIcon
  // paints a second icon on the right side of the notification — not
  // a pattern any messenger app uses, and the user shipped a clear
  // "stop" on this. The peer identity rides on the notification's
  // title text. (Messaging-style notifications get the peer portrait
  // on the LEFT instead, via the native module's shortcut-based
  // Conversation promotion — see NotifMessagingModule.)
  await notifee.displayNotification({
    id: data.conversation_id,
    title: data.title ?? 'speakeasy',
    body: data.body ?? 'New message',
    data: {
      conversation_id: data.conversation_id ?? '',
      notify_kind: data.notify_kind ?? 'message',
      ...(data.msg_type ? { msg_type: data.msg_type } : {}),
    },
    android: {
      channelId: channel,
      smallIcon: 'ic_notification',
      pressAction: { id: 'default' },
    },
  });
}

/**
 * Full-screen incoming-call notification. Uses `category: CALL` +
 * `fullScreenAction`, which on Android presents a full-screen ringing UI
 * over the lock screen (device locked) and a high-priority heads-up banner
 * with the call ringtone otherwise — so an incoming call *rings* and takes
 * over the screen rather than sliding in as a quiet banner the user notices
 * later as a "missed call" (#5).
 *
 * Requirements for the full-screen behavior on device:
 *   - `USE_FULL_SCREEN_INTENT` (AndroidManifest) + a one-time full-screen-
 *     intent DECLARATION in the Play Console (Android 14+; calling apps
 *     qualify). Without the declaration the Play upload is rejected at
 *     commit (HTTP 403).
 *   - MainActivity `showWhenLocked` + `turnScreenOn` so the launch shows
 *     over the keyguard.
 *   - A HIGH-importance channel (the 'call' channel already is).
 *
 * If the full-screen launch is ever blocked it degrades to the heads-up
 * banner — never quieter than the old generic banner.
 *
 * `fullScreenAction`/`pressAction` launch MainActivity (singleTask); the
 * push-navigation drains the persisted tap target and routes to the
 * incoming-call / connecting screen. Auto-cancels like the prior banner —
 * `routeTarget()` also cancels it by id the moment the call screen shows.
 */
async function displayCallNotification(data: FcmData): Promise<void> {
  const channel = await resolveChannel('call');
  await notifee.displayNotification({
    id: data.conversation_id,
    title: data.title ?? 'speakeasy',
    body: data.body ?? 'Incoming call',
    data: {
      conversation_id: data.conversation_id ?? '',
      notify_kind: 'call',
    },
    android: {
      channelId: channel,
      smallIcon: 'ic_notification',
      category: AndroidCategory.CALL,
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      // NOT `ongoing` — a call routes to the IncomingCall screen, not the
      // Chat screen, so nothing in the existing dismissal path cancels a
      // sticky call notification (ChatScreen cancels by conversationId on
      // open; calls never open it). An ongoing banner would linger
      // un-swipeable. Keep it auto-cancel like the prior generic banner —
      // routeTarget() also cancels it by id the moment the call screen shows.
      pressAction: { id: 'default', launchActivity: 'default' },
      fullScreenAction: { id: 'default', launchActivity: 'default' },
    },
  });
}

/**
 * Render the notification for an inbound FCM data message. For 'rich'
 * recipients the server forwards the ciphertext — decrypt it on-device
 * and stack it in a MessagingStyle notification with an inline reply.
 * Anything not decryptable (private device / sealed / call / failure)
 * falls back to a plain single-line banner.
 */
async function displayPushNotification(data: FcmData): Promise<void> {
  const conversationId = data.conversation_id;
  if (!useConversations.getState().hydrated) {
    await useConversations.getState().hydrate();
  }
  // Group banner falls back to the locally-known room name when the push
  // omits it — needs the groups store hydrated in this headless context.
  if (!useGroups.getState().hydrated) {
    await useGroups.getState().hydrate();
  }
  if (shouldSuppressPushForMute(conversationId, useConversations.getState())) {
    diag('push-bg', 'notification suppressed for muted conversation', {
      conversationId,
    });
    return;
  }
  if (
    conversationId &&
    data.notify_kind === 'message' &&
    data.ciphertext &&
    data.sender_id
  ) {
    try {
      const text = await decryptForNotification(data);
      if (text) {
        const peer = data.sender_id;
        // The durable AsyncStorage stack — NOT notifee's
        // getDisplayedNotifications, which can't see notifications posted
        // by the native NotifMessaging module, so in the background it
        // returned [] every time and the thread never stacked (each push
        // showed one message; the count badge had nothing to expand).
        const prior = await loadNotifStack(conversationId);
        await displayMessagingNotification({
          conversationId,
          peerHandle: peer,
          msgType: data.msg_type ?? 'direct',
          // Server-resolved title: the room name for groups, "@sender"
          // for 1:1 (identical to the peerHandle default there).
          title: data.title,
          messages: [
            ...prior,
            { text, timestamp: Date.now(), person: { id: peer, name: '@' + peer } },
          ],
          // Inline reply works for both 1:1 and groups now — group send
          // is reachable headlessly (SenderKey store + distributionId +
          // members all open from a background task). See
          // sendGroupReplyHeadless.
          withReply: true,
        });
        diag('push-bg', 'messaging notification displayed', { conversationId });
        return;
      }
    } catch (err) {
      diag('push-bg', 'notification decrypt failed — generic fallback', {
        conversationId,
        err: String(err),
      });
    }
  }
  // Calls get the full-screen ringing notification; everything else the
  // plain banner. (Message ciphertext already handled above and returned.)
  if (data.notify_kind === 'call') {
    await displayCallNotification(data);
    return;
  }
  await displayGenericNotification(data);
}

/** Service-backed deps for the headless 1:1 inline-reply sender. */
function replyDeps(): ReplySenderDeps {
  return {
    encrypt: (peer, plain) => signalProtocol.encrypt(peer, plain),
    getWsClient,
    // Read the device token from the Vouchflow SDK's native secure
    // storage — it is no longer mirrored into JS AsyncStorage.
    loadDeviceToken: getCachedDeviceToken,
  };
}

/**
 * Send a headless inline reply to a GROUP. Builds the same send
 * orchestrator the chat screen uses, but from a background task: the
 * SenderKey store (SQLCipher), the per-group distributionId (AsyncStorage),
 * and the member list (groups store) all open from any Android context,
 * so a backgrounded reply can fan the SKDM out and encryptForGroup just
 * like the foreground. `groupId` is derived from the conversationId
 * (`group-<groupId>`). Throws (no token / no group / WS timeout) so the
 * caller can surface a "couldn't send" banner.
 */
async function sendGroupReplyHeadless(
  conversationId: string,
  text: string,
): Promise<{ messageId: string }> {
  const groupId = conversationId.replace(/^group-/, '');
  if (!useGroups.getState().hydrated) await useGroups.getState().hydrate();
  if (!useDistributionIds.getState().hydrated)
    await useDistributionIds.getState().hydrate();
  const group = useGroups.getState().byId[groupId];
  const myUserId = await loadPersistedUserId();
  if (!group || !myUserId) throw new Error('group_reply_no_context');
  const deviceToken = await getCachedDeviceToken();
  if (!deviceToken) throw new Error('no_device_token');

  const ws = getWsClient(async () => deviceToken);
  ws.connect();
  await ws.waitForAuthed();
  const orchestrator = makeGroupOrchestrator({
    api,
    signalProtocol,
    groupMessaging,
    ws,
    getDeviceToken: async () => deviceToken,
    getOrCreateDistributionId: (id) => useDistributionIds.getState().getOrCreate(id),
  });
  return sendGroupReplyMessage(groupId, text, {
    sendGroupMessage: (opts) => orchestrator.sendGroupMessage(opts),
    members: group.members,
    selfUserId: myUserId,
  });
}

/**
 * Handle an inline-reply submission from a notification's RemoteInput.
 *
 * Receives the *whole* replied-to notification (not just its `data`):
 * its `android.style.messages` is the authoritative prior stack.
 * `getDisplayedNotifications()` is unreliable here — a notification
 * mid-reply-action is often no longer "displayed", which would drop
 * the peer's message and rebuild a degenerate self-only MessagingStyle
 * (the empty-header "strange margin" bug).
 *
 * The notification is re-posted *optimistically* with the reply
 * appended before the (multi-second) encrypt + WS send, so the banner
 * never visibly disappears. On send failure it's re-posted again with
 * an "open the app to resend" marker.
 */
async function handleInlineReply(
  notification: Notification | undefined,
  input: string | undefined,
): Promise<void> {
  const notifData = notification?.data;
  const conversationId =
    typeof notifData?.conversation_id === 'string' ? notifData.conversation_id : undefined;
  const peerId =
    typeof notifData?.sender_id === 'string' ? notifData.sender_id : undefined;
  const msgType =
    typeof notifData?.msg_type === 'string' ? notifData.msg_type : 'direct';
  await handleInlineReplyFromData({
    conversationId,
    senderId: peerId,
    msgType,
    replyText: input,
    notification,
  });
}

/**
 * Headless-friendly variant of `handleInlineReply`. The native
 * messaging notification's RemoteInput response flows through
 * `NotifMessagingReplyReceiver` → `NotifMessagingReplyService` → a
 * `SpeakeasyInlineReply` HeadlessJsTask (see `index.js`), which calls
 * this with the raw reply data — no notifee `Notification` object
 * involved.
 */
export async function handleInlineReplyFromData(args: {
  conversationId: string | undefined;
  senderId: string | undefined;
  msgType: string | undefined;
  replyText: string | undefined;
  /**
   * Notifee notification (when the reply came through notifee's
   * onBackgroundEvent — iOS / legacy Android fallback). The prior
   * stack is preferred from `loadNotifStack`; this is the secondary
   * source if nothing was persisted.
   */
  notification?: Notification;
}): Promise<void> {
  const conversationId = args.conversationId;
  const peerId = args.senderId;
  const msgType = args.msgType ?? 'direct';
  const text = (args.replyText ?? '').trim();
  if (!conversationId || !peerId || !text) return;

  // Prior stack comes from the replied-to notification itself — the
  // event detail is authoritative even when the notification is no
  // longer in the displayed set.
  // Durable store first — the notifee event detail doesn't reliably
  // carry `style.messages`, which previously dropped the peer's messages
  // and re-posted a self-only banner. Fall back to the event's own
  // style for the (rare) case where nothing was persisted.
  let prior = await loadNotifStack(conversationId);
  if (prior.length === 0)
    prior = messagesFromNotification(args.notification);
  if (prior.length === 0) {
    diag('push-reply', 'no prior messages on replied notification — stack may be lost', {
      conversationId,
    });
  }

  // Optimistic update FIRST — re-post with the reply appended before
  // the send so the banner doesn't vanish for the WS round-trip.
  // No `person` on the sent message → MessagingStyle renders it as the
  // local user.
  const isGroup = msgType === 'group';
  await displayMessagingNotification({
    conversationId,
    peerHandle: peerId,
    msgType,
    messages: [...prior, { text, timestamp: Date.now() }],
    withReply: true,
  });

  // Persist the local echo BEFORE sending. The old order sent first (the
  // send ends with a ~1500ms flush settle) and only THEN enqueued the echo
  // — so on a headless reply the in-app copy was written in the most
  // fragile window, right before the task/process tears down. If teardown
  // beat the AsyncStorage flush, the message went out (peer received it)
  // but vanished from the sender's own chat (reported bug). Minting the id
  // up front lets us queue the echo first; for 1:1 this SAME id is then
  // passed to the send so it's the wire id the peer's read receipt
  // references.
  const messageId = newMessageId();
  await enqueuePendingReply({
    conversationId,
    peerId,
    messageId,
    text,
    sentAt: Date.now(),
    msgType: isGroup ? 'group' : 'direct',
  });
  if (AppState.currentState === 'active') await drainPendingReplies();

  try {
    // Group replies fan out via the send orchestrator (SKDM bootstrap +
    // encryptForGroup); 1:1 replies use the direct Signal session. Both
    // run headlessly. The echo is already queued above, so a teardown
    // after this point no longer loses the in-app copy.
    if (isGroup) {
      await sendGroupReplyHeadless(conversationId, text);
    } else {
      await sendReplyMessage(peerId, text, replyDeps(), messageId);
    }
    diag('push-reply', 'reply sent + notification updated', { conversationId });
  } catch (err) {
    diag('push-reply', 'reply send FAILED', { conversationId, err: String(err) });
    await displayMessagingNotification({
      conversationId,
      peerHandle: peerId,
      msgType,
      messages: [
        ...prior,
        { text: `⚠️ Not sent — open the app to resend: "${text}"`, timestamp: Date.now() },
      ],
      withReply: true,
    });
  }
}

/**
 * Pre-warm the WS for an incoming call so the offer lands before the
 * user taps the notification. Only warms an ALREADY-CREATED client —
 * i.e. the app is alive in the background and its orchestrator is still
 * subscribed to receive the offer (which then sets `incoming_ringing`,
 * so the call is already ringing the instant the user foregrounds). In
 * a fresh headless context there's no `_ws` and no orchestrator, so we
 * no-op and let the foreground bring the WS up normally. Best-effort:
 * never throws into the message handler.
 */
async function prewarmWsForIncomingCall(): Promise<void> {
  try {
    const ws = peekWsClient();
    if (!ws) return;
    const st = ws.getState();
    if (st === 'authed' || st === 'authenticating' || st === 'connecting') {
      return; // already warm / warming
    }
    diag('push-bg', 'call push — pre-warming WS for fast pickup', { state: st });
    ws.connect();
    await ws.waitForAuthed(8000);
    diag('push-bg', 'call push — WS warmed (offer can arrive now)', {});
  } catch (err) {
    diag('push-bg', 'call push — WS prewarm failed (continuing)', {
      err: String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// TOP-LEVEL HANDLER REGISTRATION (Android only)
// CRITICAL: This MUST execute at module load, not in a function.
// Android Headless JS expects the handlers to exist when the bundle loads.
// ---------------------------------------------------------------------------

if (Platform.OS === 'android') {
  // Data-only FCM messages — the OS shows nothing, so the app renders
  // the notification itself (and decrypts it for 'rich' devices).
  messaging().setBackgroundMessageHandler(async (remoteMessage: RemoteMessage) => {
    const data = (remoteMessage.data ?? {}) as FcmData;
    diag('push-bg', 'background message received', {
      conversationId: data.conversation_id,
      kind: data.notify_kind,
      msgType: data.msg_type,
      hasCiphertext: !!data.ciphertext,
    });
    if (!data.conversation_id || !data.notify_kind) {
      diag('push-bg', 'incomplete FCM data — skipping', { data });
      return;
    }
    // For a CALL wake-push, start warming the WS NOW — in parallel with
    // showing the notification — so the call_offer is delivered over the
    // (background-closed) WS while the user is still reaching for the
    // notification. Without this the WS only reconnects on tap/foreground
    // and the offer lands ~3.8s later (rc.54 trace: tap→ring ~4.6s).
    const warming =
      data.notify_kind === 'call' ? prewarmWsForIncomingCall() : undefined;
    await displayPushNotification(data);
    await warming;
  });

  // Notification taps that land while the app is backgrounded/quit.
  // The headless context can't navigate, so persist the tap target —
  // the foreground app drains it (see usePushNavigation).
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    // Inline reply submitted from a notification's RemoteInput field.
    if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'reply') {
      await handleInlineReply(detail.notification, detail.input);
      return;
    }
    if (type !== EventType.PRESS) return;
    const p = toPersistedPush((detail.notification?.data ?? {}) as FcmData);
    if (p) {
      await persistRawPush(p);
      diag('push-bg', 'tap-target persisted', { conversationId: p.conversationId });
    }
  });

  diag('push', 'background message + notifee handlers registered');
}

// ---------------------------------------------------------------------------
// FOREGROUND HANDLER (exported for App.tsx to call after module init)
// ---------------------------------------------------------------------------

let foregroundHandlerUnsub: (() => void) | undefined;

export function registerForegroundMessageHandler(): void {
  if (foregroundHandlerUnsub) return;

  foregroundHandlerUnsub = messaging().onMessage((remoteMessage: RemoteMessage) => {
    const data = (remoteMessage.data ?? {}) as FcmData;
    // No notification while the app is foregrounded — the message
    // renders in-app once it drains over the WebSocket.
    diag('push-fg', 'foreground push received (no banner)', {
      conversationId: data.conversation_id,
      kind: data.notify_kind,
      msgType: data.msg_type,
    });
  });

  diag('push', 'foreground message handler registered');
}

export function unregisterForegroundMessageHandler(): void {
  foregroundHandlerUnsub?.();
  foregroundHandlerUnsub = undefined;
}

// ---------------------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------------------

/**
 * Dismiss the full-screen call notification (posted by
 * `displayCallNotification`, id = conversationId) once the user lands on
 * the call screen. Calls never open ChatScreen, which is the only place
 * that otherwise cancels a notification by conversationId — so without
 * this an answered/handled call would leave its ring banner up.
 */
async function cancelCallNotification(target: {
  conversationId: string;
}): Promise<void> {
  if (!target.conversationId) return;
  try {
    await notifee.cancelNotification(target.conversationId);
  } catch (err) {
    diag('push-nav', 'cancel call notification failed', { err: String(err) });
  }
}

async function routeTarget(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  target: NavTarget,
  _callOrchestrator?: CallOrchestrator,
): Promise<void> {
  switch (target.kind) {
    case 'call-live':
      // IncomingCallScreen reads from useCalls.active — it will render
      // because we verified active.stage === 'incoming_ringing'.
      void cancelCallNotification(target);
      navRef.current?.navigate('IncomingCall');
      return;
    case 'call-stale':
      void cancelCallNotification(target);
      navRef.current?.navigate('Chat', { peerId: target.peerId });
      return;
    case 'call-connecting':
      void cancelCallNotification(target);
      navRef.current?.navigate('IncomingCall', { connectingPeerId: target.peerId });
      return;
    case 'group':
      navRef.current?.navigate('GroupChat', { groupId: target.groupId });
      return;
    case 'direct':
      navRef.current?.navigate('Chat', { peerId: target.peerId });
      return;
  }
}

export function usePushNavigation(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  navReady: boolean,
  callOrchestrator?: CallOrchestrator,
): void {
  const hydrated = useConversations((s) => s.hydrated);
  const userId = useIdentity((s) => s.userId);
  const startupHandledRef = useRef(false);

  useEffect(() => {
    // navReady gates routing: on a cold start the stores hydrate
    // before the NavigationContainer mounts, and navigate() on a null
    // navRef is a silent no-op.
    if (!hydrated || !userId || !navReady) return;

    let cancelled = false;

    async function route(p: PersistedPush, source: string): Promise<void> {
      const target = resolveTargetAtConsumeTime(p);
      if (!target) {
        diag('push-nav', 'tap-target could not be resolved', {
          source,
          conversationId: p.conversationId,
          kind: p.kind,
        });
        return;
      }
      diag('push-nav', 'routing tapped push', {
        source,
        conversationId: p.conversationId,
        kind: p.kind,
        target: target.kind,
      });
      await routeTarget(navRef, target, callOrchestrator);
    }

    // Cold start: the notifee notification that launched the app from a
    // quit state, plus any tap target the background event handler
    // persisted before this hook mounted. Runs once per process. Also
    // drains the native tap slot stashed by MainActivity when a
    // SpeakeasyNotifMessaging notification was tapped.
    async function handleStartup() {
      if (startupHandledRef.current) return;
      startupHandledRef.current = true;
      try {
        // Native messaging notification tap (takes precedence — these
        // are the messaging notifications shipping from rc.124+).
        const nativeTap = await NotifMessaging.consumePendingTap();
        if (nativeTap && !cancelled) {
          const p = toPersistedPush(nativeTap as unknown as FcmData);
          if (p) {
            await route(p, 'native-tap-cold');
            return;
          }
        }
        const initial = await notifee.getInitialNotification();
        const data = initial?.notification?.data as FcmData | undefined;
        if (data && !cancelled) {
          const p = toPersistedPush(data);
          if (p) {
            await route(p, 'cold-start');
            // Drain the slot the background tap handler also persisted
            // for this same tap so it can't re-fire on resume.
            void consumeRawPush();
            return;
          }
        }
        if (!cancelled) {
          const deferred = await consumeRawPush();
          if (deferred) await route(deferred, 'deferred');
        }
      } catch (err) {
        diag('push-nav', 'startup notification handling failed', {
          err: String(err),
        });
      }
    }
    void handleStartup();
    // Fold any inline replies sent from a notification banner into
    // the in-app conversation log (queued headlessly, drained here
    // now that the foreground store is hydrated).
    void drainPendingReplies();

    // Warm taps / inline replies on a notification while the app is
    // already foregrounded (the banner was still in the tray).
    const fgUnsub = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'reply') {
        void handleInlineReply(detail.notification, detail.input);
        return;
      }
      if (type !== EventType.PRESS) return;
      const p = toPersistedPush((detail.notification?.data ?? {}) as FcmData);
      if (p) void route(p, 'fg-tap');
    });

    // A tap that landed while the app was backgrounded was persisted by
    // notifee.onBackgroundEvent — drain it when the app returns active.
    // Same for native messaging notifications, whose tap target is
    // stashed by MainActivity.onNewIntent.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void drainPendingReplies();
      void (async () => {
        const nativeTap = await NotifMessaging.consumePendingTap();
        if (nativeTap && !cancelled) {
          const np = toPersistedPush(nativeTap as unknown as FcmData);
          if (np) {
            await route(np, 'native-tap-resume');
            return;
          }
        }
        const deferred = await consumeRawPush();
        if (deferred && !cancelled) await route(deferred, 'resume-tap');
      })();
    });

    return () => {
      cancelled = true;
      fgUnsub();
      appStateSub.remove();
    };
  }, [hydrated, userId, navReady, navRef, callOrchestrator]);
}
