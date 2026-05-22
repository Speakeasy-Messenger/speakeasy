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
  AndroidImportance,
  AndroidStyle,
  EventType,
  type Notification,
} from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodePayload } from '@speakeasy/shared';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStack } from '../navigation/RootNavigator.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';
import { useCalls } from '../store/calls.js';
import { signalProtocol, groupMessaging, getWsClient } from '../services.js';
import { b64ToBytes, utf8FromBytes } from '../utils/bytes.js';
import {
  sendReplyMessage,
  loadPersistedUserId,
  type ReplySenderDeps,
} from './reply-sender.js';
import { cachedAvatarUri } from './avatar-cache.js';
import { getCachedDeviceToken } from '../native/cached-device-token.js';

type RemoteMessage = FirebaseMessagingTypes.RemoteMessage;

/** Android notification channel — also created natively in MainActivity. */
const CHANNEL_ID = 'speakeasy_default';

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
  /** Peer handle — used to (re)open the direct conversation. */
  peerId: string;
  messageId: string;
  text: string;
  sentAt: number;
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
      return { kind: 'call-live' };
    }
    if (peerId) {
      diag('push-nav', 'call push stale — routing to chat instead', {
        conversationId,
        ageMs,
        liveStage: live?.stage,
      });
      return { kind: 'call-stale', peerId };
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

async function ensureChannel(): Promise<void> {
  // Idempotent — re-creating an existing channel is a no-op. Needed
  // because a headless launch may run before MainActivity created it.
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Messages',
    importance: AndroidImportance.HIGH,
  });
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

/**
 * The messages already stacked on the displayed notification for this
 * conversation. Returns [] when none is showing — so once the user
 * opens the chat (which cancels the notification) the next message
 * starts a fresh stack.
 */
async function existingMessages(conversationId: string): Promise<MsgStyleMsg[]> {
  try {
    const shown = await notifee.getDisplayedNotifications();
    const match = shown.find((n) => n.notification?.id === conversationId);
    return messagesFromNotification(match?.notification);
  } catch {
    /* getDisplayedNotifications can fail headlessly — start fresh */
    return [];
  }
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
}): Promise<void> {
  await ensureChannel();
  // Stamp each Person with its cached avatar so the notification shows
  // the real animal portrait (a Person with no icon renders Android's
  // generic silhouette). Peer messages carry a `person`; self messages
  // (sent replies) have none — MessagingStyle renders those as the
  // top-level `style.person`, which carries the local user's avatar.
  const peerIcon = await cachedAvatarUri(args.peerHandle);
  const myUserId = await loadPersistedUserId();
  const selfIcon = myUserId ? await cachedAvatarUri(myUserId) : undefined;
  const selfPerson = {
    ...SELF_PERSON,
    // If the local avatar cache is cold, prefer the app notification
    // resource over Android's generic silhouette.
    icon: selfIcon ?? 'ic_notification',
  };
  const messages = args.messages.slice(-MAX_NOTIF_MESSAGES).map((m) =>
    m.person
      ? {
          ...m,
          person: {
            ...m.person,
            icon: peerIcon ?? m.person.icon ?? 'ic_notification',
          },
        }
      : m,
  );
  // Durable copy of the stack so an inline reply can rebuild the full
  // thread even when the notifee event detail omits `style.messages`.
  // Awaited, not fire-and-forget: a headless display task can be torn
  // down the moment this function resolves, and an unfinished
  // AsyncStorage write left the next reply with an empty stack — the
  // notification then re-posted showing only the user's own reply.
  await persistNotifStack(args.conversationId, messages);
  const latest = messages[messages.length - 1];
  await notifee.displayNotification({
    id: args.conversationId,
    // Fallbacks for surfaces that don't render MessagingStyle.
    title: '@' + args.peerHandle,
    body: latest?.text ?? 'New message',
    data: {
      conversation_id: args.conversationId,
      notify_kind: 'message',
      msg_type: args.msgType,
      sender_id: args.peerHandle,
    },
    android: {
      channelId: CHANNEL_ID,
      smallIcon: 'ic_notification',
      ...(peerIcon ? { largeIcon: peerIcon } : {}),
      pressAction: { id: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: selfPerson,
        messages,
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

/** Plain single-line notification — private device / sealed / call. */
async function displayGenericNotification(data: FcmData): Promise<void> {
  await ensureChannel();
  // Show the counterparty's avatar as the large icon — a call or a
  // plain-banner message should still read as "from <peer>", not the
  // app logo. Sealed messages carry no `sender_id` (the server strips
  // it upstream), so they keep the logo — the privacy-correct outcome.
  const largeIcon = data.sender_id
    ? await cachedAvatarUri(data.sender_id)
    : undefined;
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
      channelId: CHANNEL_ID,
      smallIcon: 'ic_notification',
      ...(largeIcon ? { largeIcon } : {}),
      pressAction: { id: 'default' },
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
        const prior = await existingMessages(conversationId);
        await displayMessagingNotification({
          conversationId,
          peerHandle: peer,
          msgType: data.msg_type ?? 'direct',
          messages: [
            ...prior,
            { text, timestamp: Date.now(), person: { id: peer, name: '@' + peer } },
          ],
          // Inline reply is 1:1 only — group send needs JS-side
          // SenderKey state that isn't reachable headlessly.
          withReply: data.msg_type !== 'group',
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
  await displayGenericNotification(data);
}

/** Service-backed deps for the headless inline-reply sender. */
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
  const text = (input ?? '').trim();
  if (!conversationId || !peerId || !text) return;

  // Prior stack comes from the replied-to notification itself — the
  // event detail is authoritative even when the notification is no
  // longer in the displayed set.
  // Durable store first — the notifee event detail doesn't reliably
  // carry `style.messages`, which previously dropped the peer's messages
  // and re-posted a self-only banner. Fall back to the event's own
  // style for the (rare) case where nothing was persisted.
  let prior = await loadNotifStack(conversationId);
  if (prior.length === 0) prior = messagesFromNotification(notification);
  if (prior.length === 0) {
    diag('push-reply', 'no prior messages on replied notification — stack may be lost', {
      conversationId,
    });
  }

  // Optimistic update FIRST — re-post with the reply appended before
  // the send so the banner doesn't vanish for the WS round-trip.
  // No `person` on the sent message → MessagingStyle renders it as the
  // local user.
  await displayMessagingNotification({
    conversationId,
    peerHandle: peerId,
    msgType,
    messages: [...prior, { text, timestamp: Date.now() }],
    withReply: msgType !== 'group',
  });

  try {
    const { messageId } = await sendReplyMessage(peerId, text, replyDeps());
    // Record the reply in the in-app conversation log. Queued (not
    // added straight to the store) because this may run headlessly
    // with an un-hydrated store; drained right away when the app is
    // already foreground, otherwise on the next foreground.
    //
    // `messageId` MUST be the id that went out on the wire — the peer's
    // read receipt references it. Minting a fresh id here is what left
    // inline replies showing no read receipt.
    await enqueuePendingReply({
      conversationId,
      peerId,
      messageId,
      text,
      sentAt: Date.now(),
    });
    if (AppState.currentState === 'active') await drainPendingReplies();
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
      withReply: msgType !== 'group',
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
    await displayPushNotification(data);
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

async function routeTarget(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  target: NavTarget,
  _callOrchestrator?: CallOrchestrator,
): Promise<void> {
  switch (target.kind) {
    case 'call-live':
      // IncomingCallScreen reads from useCalls.active — it will render
      // because we verified active.stage === 'incoming_ringing'.
      navRef.current?.navigate('IncomingCall');
      return;
    case 'call-stale':
      navRef.current?.navigate('Chat', { peerId: target.peerId });
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
    // persisted before this hook mounted. Runs once per process.
    async function handleStartup() {
      if (startupHandledRef.current) return;
      startupHandledRef.current = true;
      try {
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
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void drainPendingReplies();
      void (async () => {
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
