import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { secureKv } from '../native/secure-kv.js';
import {
  DEFAULT_TTL_SECONDS,
  TTL_OPTIONS,
  conversationIdForDirect,
  type Attachment,
  type ConversationKind,
  type TtlOption,
} from '@speakeasy/shared';
import type { DisappearingStage } from '../components/disappearing-stage.js';

/**
 * Per-conversation message list + TTL config + persistence opt-in.
 *
 * Persisted so chat history survives app restarts. The decrypted
 * message bodies are sensitive, so persistence goes through `secureKv`
 * — the SQLCipher-backed `kv` table — NOT plaintext AsyncStorage.
 * Spec §5 still says messages disappear by default — that's the local
 * TTL engine's job; persistence here just keeps undisappeared messages
 * across cold starts.
 *
 * History note: this store used to write cleartext JSON to AsyncStorage
 * (an unencrypted SQLite file). `hydrate` scrubs that legacy plaintext
 * key on every run so no decrypted history lingers on disk.
 */

const STORAGE_KEY = 'speakeasy.conversations.v1';

export interface ChatMessage {
  /** Server-assigned message id (ULID). */
  id: string;
  /** Sender id (handle or legacy 3-word), or 'me' for the local user. */
  from: string;
  /**
   * Display text. May be empty when the message is attachment-only.
   * Decrypted Signal plaintext is parsed via shared/attachments
   * `decodePayload` — text and attachments come from the same envelope.
   */
  text: string;
  /** Optional attachments (images, gifs, files). When present, the
   * bubble renders them above any caption text. */
  attachments?: Attachment[];
  /** Handles @mentioned in this message (bare, no @ prefix). */
  mentions?: string[];
  /** Conversation membership type — affects routing on outbound. */
  kind: ConversationKind;
  /** Wall-clock send time (ms) — the sender's clock at the moment
   *  they hit send. Used for the bubble's displayed timestamp. */
  sentAt: number;
  /** Wall-clock ms when THIS device first saw the message. For sent
   *  messages this equals sentAt. For received messages this is the
   *  WS-delivery time, which can be much later than sentAt when the
   *  server buffered the message while the recipient was offline.
   *
   *  Conversation rendering sorts by this (with sentAt as fallback
   *  for messages persisted before the field existed) so a late-
   *  delivered message lands at the BOTTOM of the chat where the
   *  user expects it after tapping its push notification — instead
   *  of buried earlier in history at its send-time position.
   *
   *  Optional for back-compat with persisted state from older
   *  versions that didn't track it.
   */
  receivedAt?: number;
  /** Animated dissolve stage; updated by the local TTL engine. */
  stage: DisappearingStage;
  /**
   * For sent messages (`from === 'me'`): true once the server has
   * fired a `delivered` WS frame for this message_id, meaning the
   * recipient has acked across all their devices (per Phase 5f
   * per-device delivery tracking). Surfaces as a `✓✓` glyph on
   * the bubble. False for inbound messages and for sent messages
   * still in-flight.
   *
   * For 1:1 only — group/community don't emit `delivered` (one
   * frame per recipient ack would fan out N events; spec §5).
   */
  delivered?: boolean;
  /**
   * Wall-clock ms when the recipient opened the chat with this
   * message in view. Set on inbound `read` server frames. Surfaces
   * on sent bubbles as a brass `✓✓` (vs slate `✓✓` for delivered-
   * but-not-read). Undefined while the message is still unread.
   *
   * 1:1 only — group/community read receipts are deferred for the
   * same room-activity-leak reason as the `read` frame.
   */
  readAt?: number;
  /**
   * For inbound messages (`from !== 'me'`): true once this device has
   * sent a `read` WS frame for it. Persisted so the receipt is emitted
   * exactly once — not re-blasted on every ChatScreen remount. The old
   * per-mount `readSentRef` Set reset on remount/cold-start, so
   * reopening a chat re-sent `read` for the whole visible history.
   */
  readReceiptSent?: boolean;
  /**
   * For sent messages: set when the outbound send path failed (no WS,
   * encrypt error, etc.). When present, the bubble renders muted with a
   * "Tap to resend" cue and a tap on the bubble re-runs the send path
   * using the same wire id, so the eventual `delivered`/`read` acks
   * attach to the original bubble. Cleared on the next retry attempt.
   *
   * The previous behavior was to append a separate `[send failed: …]`
   * bubble while the optimistic echo lingered with a single ✓ — the
   * user couldn't tell which message failed or how to recover.
   */
  sendFailure?: string;
}

export interface ConversationState {
  /** Conversation kind, set on creation. Used by the list screen to label/group. */
  kind: ConversationKind;
  /**
   * For `direct` conversations: the peer's user id. Lets the list show
   * "who is this with" before any messages have been exchanged. Undefined
   * for group/community where membership lives elsewhere.
   */
  peerUserId?: string;
  /** Wall-clock ms when the conversation was first opened locally. */
  createdAt: number;
  messages: ChatMessage[];
  /** TTL option per spec §5; default is `week`. */
  ttl: TtlOption;
  /**
   * If true, the local TTL engine does not dissolve messages for this
   * conversation. Server-side TTL behavior is unchanged (spec §5).
   */
  persistenceEnabled: boolean;
  /**
   * Wall-clock ms of the last message the user has seen in this
   * conversation. Messages with sentAt > lastReadAt are "unread".
   * Undefined / 0 means nothing has been read yet.
   */
  lastReadAt?: number;
  /**
   * Per-conversation notification suppression — set from the
   * Conversation Settings screen's Mute toggle (CONVERSATIONS.md
   * §2.10). When true, in-app banners and OS push notifications
   * for this conversation are dropped. Default false.
   */
  muted?: boolean;
  /**
   * Marks the conversation as terminal: the peer's account has been
   * deleted server-side. Set by the WS `peer_deleted` frame handler
   * (Phase 1 peer-deleted). When true the ChatScreen disables the
   * input + send button; the user can still scroll history but
   * cannot compose. Distinct from `muted` (notifications only) and
   * from `blocked` (lives in a separate store) — a frozen
   * conversation has no live counterparty at all.
   */
  frozen?: boolean;
}

interface ConversationsState {
  byId: Record<string, ConversationState>;
  /** True once `hydrate()` has run (loaded from disk on startup). */
  hydrated: boolean;
  /**
   * Receipts that arrived before their target message landed in the
   * store. Keyed by message id (the wire id). Inline replies sent from
   * a notification banner are added to the store on the next foreground
   * (see push-handler.drainPendingReplies), which can lose a race with
   * the WS replaying buffered `delivered`/`read` acks from the server.
   * Without this catch, an inline reply was stuck on a single ✓ even
   * though the peer had already read it. In-memory only — buffered acks
   * are durable on the server side, so a process restart re-fires them.
   */
  _pendingReceipts: Record<string, { delivered?: boolean; readAt?: number }>;
  /**
   * Open (or refresh) a 1:1 conversation with `peerUserId`. Idempotent —
   * doesn't reset messages or settings if the conversation already exists.
   * Returns the conversationId for navigation.
   */
  openDirect: (myUserId: string, peerUserId: string) => string;
  /**
   * Ensure a `group` conversation entry exists. Idempotent — preserves
   * messages + settings if the group has already been opened. Lets
   * `markRead` (and the messages selector) operate on a stable entry
   * the first time a freshly-created group is opened, before any
   * message has been sent or received.
   */
  openGroup: (groupId: string) => void;
  add: (conversationId: string, msg: ChatMessage) => void;
  setStage: (conversationId: string, msgId: string, stage: DisappearingStage) => void;
  /**
   * Flip a sent message's delivered flag to true (response to the
   * server's `delivered` WS frame). The msgId is the server-assigned
   * one; the optimistic-echo bubble uses that id, so this matches.
   */
  markDelivered: (msgId: string) => void;
  /**
   * Stamp `readAt` on a sent message — fires when the server forwards
   * a `read` WS frame from the original recipient. UI flips ✓✓ from
   * slate to brass.
   */
  markMessageRead: (msgId: string, readAt: number) => void;
  /**
   * Mark that a `read` receipt frame has been sent for an inbound
   * message, so ChatScreen does not re-emit it on remount / cold start.
   */
  markReadReceiptSent: (conversationId: string, msgId: string) => void;
  /**
   * Stamp / clear a send-failure marker on a sent message. Passing
   * `undefined` clears the marker (used on retry-start so the bubble
   * loses its muted "tap to resend" treatment while the new attempt
   * is in flight).
   */
  setSendFailure: (conversationId: string, msgId: string, reason: string | undefined) => void;
  /**
   * Implicit read receipts. When the peer sends a message in a 1:1
   * conversation, they have necessarily seen everything we sent before
   * that point — so any of our outbound bubbles in this conversation
   * with `sentAt <= readAt` get stamped `readAt`. Closes the gap when
   * the peer's client doesn't emit explicit `read` WS frames (older
   * builds, peers that read via push only) and the bubble would
   * otherwise be stuck on a faded ✓✓ (delivered) forever.
   */
  markReadUpTo: (conversationId: string, readAt: number) => void;
  remove: (conversationId: string, msgId: string) => void;
  /** Drop the entire conversation entry. Used by group leave (the
   * room disappears from the user's local list) and by 1:1 delete. */
  removeConversation: (conversationId: string) => void;
  setTtl: (conversationId: string, ttl: TtlOption) => void;
  setPersistence: (conversationId: string, on: boolean) => void;
  /** Toggle per-conversation notification suppression. */
  setMuted: (conversationId: string, muted: boolean) => void;
  setFrozen: (conversationId: string, frozen: boolean) => void;
  /** Resolved TTL in seconds, or `null` if `off` / persistence is on. */
  ttlSecondsFor: (conversationId: string) => number | null;
  /** Mark a conversation as read up to the current time. */
  markRead: (conversationId: string) => void;
  /** Count of unread messages in a conversation. */
  unreadCountFor: (conversationId: string) => number;
  /** Read persisted state from disk. Idempotent. */
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

function emptyConversation(kind: ConversationKind): ConversationState {
  return {
    kind,
    createdAt: Date.now(),
    messages: [],
    ttl: 'week',
    persistenceEnabled: false,
  };
}

/**
 * Append `msg` keeping `messages` ordered by **send time** (sentAt) —
 * chronological order, like every mainstream messenger.
 *
 * # Why sentAt (changed from receivedAt)
 *
 * The server buffers messages while a recipient is offline, then relays
 * them in a batch when the WS reconnects — and because the app tears the
 * socket down on every background, that delivery is fragmented across
 * reconnects and can arrive out of *send* order (a live message lands
 * before older buffered ones). Ordering by arrival time made a backlog
 * batch render at the bottom out of sent-order — visibly scrambled
 * (reported 2026-06-14: 2:33–2:37pm messages interleaved wrong).
 *
 * Historic note: receivedAt ordering was adopted for the rc.19
 * "peachtree" case — a tapped push message inserted several messages back
 * at its sentAt position, so the user couldn't spot it at the bottom.
 * That concern is real but belongs to an unread / "new messages" jump
 * indicator, not to scrambling chronological order. The bubble's
 * displayed timestamp was always sentAt; now the ordering matches it.
 */
function localOrderKey(m: ChatMessage): number {
  return m.sentAt;
}

function insertByLocalOrder(
  messages: ChatMessage[],
  msg: ChatMessage,
): ChatMessage[] {
  const last = messages[messages.length - 1];
  const k = localOrderKey(msg);
  if (!last || k >= localOrderKey(last)) return [...messages, msg];
  const at = messages.findIndex((m) => localOrderKey(m) > k);
  return [...messages.slice(0, at), msg, ...messages.slice(at)];
}

function attachmentsMatch(
  a: ChatMessage['attachments'],
  b: ChatMessage['attachments'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.kind !== y.kind ||
      x.mime !== y.mime ||
      x.name !== y.name ||
      x.data.length !== y.data.length
    ) {
      return false;
    }
  }
  return true;
}

async function persist(byId: Record<string, ConversationState>): Promise<void> {
  try {
    await secureKv.set(STORAGE_KEY, JSON.stringify(byId));
  } catch {
    // Persistence failure is non-fatal — in-memory state is the source
    // of truth for the current session. Before enrollment the encrypted
    // DB isn't open yet; that rejection lands here and is ignored.
  }
}

export const useConversations = create<ConversationsState>((set, get) => ({
  byId: {},
  hydrated: false,
  _pendingReceipts: {},

  openDirect: (myUserId, peerUserId) => {
    const id = conversationIdForDirect(myUserId, peerUserId);
    set((s) => {
      if (s.byId[id]) return s; // idempotent — preserve messages + settings
      return {
        byId: {
          ...s.byId,
          [id]: { ...emptyConversation('direct'), peerUserId },
        },
      };
    });
    void persist(get().byId);
    return id;
  },

  openGroup: (groupId) => {
    set((s) => {
      if (s.byId[groupId]) return s; // idempotent — preserve messages + settings
      return {
        byId: { ...s.byId, [groupId]: emptyConversation('group') },
      };
    });
    void persist(get().byId);
  },

  add: (conversationId, msg) => {
    set((s) => {
      const existing = s.byId[conversationId];
      const c = existing ?? emptyConversation(msg.kind);
      // Dedupe by message id. The server may redeliver a message whose
      // ack we sent but didn't reach (e.g. WS flap mid-flush). Without
      // this guard, every redelivery of the same ciphertext re-runs
      // libsignal decrypt against an already-advanced ratchet, fails,
      // and pushes a fresh "[decrypt failed]" bubble. Sender ids are
      // server-assigned ULIDs for inbound (handler.ts:directMessageId)
      // and client-generated ULIDs for the optimistic local echo —
      // they live in disjoint id spaces so this dedupe never drops a
      // legitimately distinct message.
      if (c.messages.some((m) => m.id === msg.id)) return s;
      // Content-level dedupe for distinct-msgId duplicates: a sender that
      // retries during a flaky upload (or a server replay path that
      // assigns a fresh id) lands two identical bubbles with different
      // ULIDs. The msgId guard above misses these; this catches them
      // when the text + sender + attachments match within a 2s window.
      // Scoped to inbound (`from !== 'me'`) so a user's own deliberate
      // double-tap of an outbound is never silently dropped.
      if (msg.from !== 'me' && msg.from !== 'system') {
        const isDuplicate = c.messages.some(
          (m) =>
            m.from === msg.from &&
            m.text === msg.text &&
            attachmentsMatch(m.attachments, msg.attachments) &&
            Math.abs(m.sentAt - msg.sentAt) < 2000,
        );
        if (isDuplicate) return s;
      }
      let peerUserId = c.peerUserId;
      // Capture the peer's userId on first inbound message for direct
      // conversations. Skip the system pseudo-sender — call-end logs
      // and other system bubbles use `from: 'system'`, which would
      // otherwise create a phantom @system conversation entry on the
      // list screen instead of attaching the log to the actual peer's
      // chat. (User report: incoming-call log appearing under @system
      // for friends who hadn't messaged the local user yet.)
      if (
        msg.kind === 'direct' &&
        !peerUserId &&
        msg.from !== 'me' &&
        msg.from !== 'system'
      ) {
        peerUserId = msg.from;
      }
      // Fold in any receipt that arrived before this message landed.
      // Inline replies queued from a notification's RemoteInput drain
      // into the store after the foreground app comes up; the server's
      // buffered `delivered`/`read` acks for that wire id can arrive
      // first, hit no message, and be parked here. Apply them now.
      //
      // Also stamp receivedAt — this is the canonical place. The
      // upstream callers (router.addToConversation, ChatScreen's
      // optimistic local echo, inline-reply drain) don't all know
      // about ordering policy; centralizing the stamp here keeps
      // localOrderKey's contract simple. msg.receivedAt being set
      // already (e.g. during rehydration from persistence) means
      // "use what's already there"; missing means "now".
      let merged: ChatMessage = {
        ...msg,
        receivedAt: msg.receivedAt ?? Date.now(),
      };
      const pending = s._pendingReceipts[msg.id];
      let nextPending = s._pendingReceipts;
      if (pending) {
        merged = {
          ...merged,
          delivered: pending.delivered || msg.delivered || !!pending.readAt,
          ...(pending.readAt ? { readAt: pending.readAt } : {}),
        };
        const { [msg.id]: _drop, ...rest } = s._pendingReceipts;
        nextPending = rest;
      }
      return {
        byId: {
          ...s.byId,
          [conversationId]: {
            ...c,
            peerUserId,
            messages: insertByLocalOrder(c.messages, merged),
          },
        },
        _pendingReceipts: nextPending,
      };
    });
    void persist(get().byId);
  },

  setStage: (conversationId, msgId, stage) =>
    set((s) => {
      const c = s.byId[conversationId];
      if (!c) return s;
      return {
        byId: {
          ...s.byId,
          [conversationId]: {
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? { ...m, stage } : m)),
          },
        },
      };
    }),

  // The `delivered` server frame doesn't tell us which conversation
  // the message belongs to — just the message_id. Walk every
  // conversation looking for a matching message id; flip its
  // delivered flag if found. This is O(total messages) but the
  // event is rare (one per sent message acknowledged) and total
  // messages is small (TTL bounds it). The map-of-messages → flat
  // list trade-off can come later if profiling demands it.
  markDelivered: (msgId) =>
    set((s) => {
      let touched = false;
      const next: Record<string, ConversationState> = {};
      for (const [convId, conv] of Object.entries(s.byId)) {
        const idx = conv.messages.findIndex((m) => m.id === msgId);
        if (idx === -1) {
          next[convId] = conv;
          continue;
        }
        const msg = conv.messages[idx]!;
        if (msg.delivered) {
          // Already marked — server may have re-fired due to
          // multi-device or AckRouter cross-instance redelivery.
          next[convId] = conv;
          continue;
        }
        const updated: ChatMessage[] = [...conv.messages];
        updated[idx] = { ...msg, delivered: true };
        next[convId] = { ...conv, messages: updated };
        touched = true;
      }
      if (!touched) {
        // Park the receipt for an inline-reply message that hasn't
        // drained into the store yet — see `_pendingReceipts` doc.
        return {
          _pendingReceipts: {
            ...s._pendingReceipts,
            [msgId]: { ...s._pendingReceipts[msgId], delivered: true },
          },
        };
      }
      void persist(next);
      return { byId: next };
    }),

  markMessageRead: (msgId, readAt) =>
    set((s) => {
      let touched = false;
      const next: Record<string, ConversationState> = {};
      for (const [convId, conv] of Object.entries(s.byId)) {
        const idx = conv.messages.findIndex((m) => m.id === msgId);
        if (idx === -1) {
          next[convId] = conv;
          continue;
        }
        const msg = conv.messages[idx]!;
        if (msg.readAt) {
          // Already stamped (multi-device fan-out, server redelivery).
          next[convId] = conv;
          continue;
        }
        const updated: ChatMessage[] = [...conv.messages];
        // Implicitly delivered (you can't read what wasn't delivered).
        updated[idx] = { ...msg, readAt, delivered: true };
        next[convId] = { ...conv, messages: updated };
        touched = true;
      }
      if (!touched) {
        return {
          _pendingReceipts: {
            ...s._pendingReceipts,
            [msgId]: {
              ...s._pendingReceipts[msgId],
              readAt,
              delivered: true,
            },
          },
        };
      }
      void persist(next);
      return { byId: next };
    }),

  markReadReceiptSent: (conversationId, msgId) => {
    set((s) => {
      const c = s.byId[conversationId];
      if (!c) return s;
      let touched = false;
      const messages = c.messages.map((m) => {
        if (m.id === msgId && !m.readReceiptSent) {
          touched = true;
          return { ...m, readReceiptSent: true };
        }
        return m;
      });
      if (!touched) return s;
      return { byId: { ...s.byId, [conversationId]: { ...c, messages } } };
    });
    void persist(get().byId);
  },

  setSendFailure: (conversationId, msgId, reason) => {
    set((s) => {
      const c = s.byId[conversationId];
      if (!c) return s;
      let touched = false;
      const messages = c.messages.map((m) => {
        if (m.id !== msgId) return m;
        if (m.sendFailure === reason) return m;
        touched = true;
        if (reason === undefined) {
          const { sendFailure: _drop, ...rest } = m;
          return rest;
        }
        return { ...m, sendFailure: reason };
      });
      if (!touched) return s;
      return { byId: { ...s.byId, [conversationId]: { ...c, messages } } };
    });
    void persist(get().byId);
  },

  markReadUpTo: (conversationId, readAt) => {
    set((s) => {
      const c = s.byId[conversationId];
      if (!c) return s;
      let touched = false;
      const messages = c.messages.map((m) => {
        if (m.from !== 'me') return m;
        if (m.sentAt > readAt) return m;
        if (m.readAt) return m;
        touched = true;
        return { ...m, readAt, delivered: true };
      });
      if (!touched) return s;
      return { byId: { ...s.byId, [conversationId]: { ...c, messages } } };
    });
    void persist(get().byId);
  },

  remove: (conversationId, msgId) => {
    set((s) => {
      const c = s.byId[conversationId];
      if (!c) return s;
      return {
        byId: {
          ...s.byId,
          [conversationId]: {
            ...c,
            messages: c.messages.filter((m) => m.id !== msgId),
          },
        },
      };
    });
    void persist(get().byId);
  },

  removeConversation: (conversationId) => {
    set((s) => {
      if (!s.byId[conversationId]) return s;
      const { [conversationId]: _gone, ...rest } = s.byId;
      return { byId: rest };
    });
    void persist(get().byId);
  },

  setTtl: (conversationId, ttl) => {
    set((s) => {
      const c = s.byId[conversationId] ?? emptyConversation('direct');
      return { byId: { ...s.byId, [conversationId]: { ...c, ttl } } };
    });
    void persist(get().byId);
  },

  setPersistence: (conversationId, persistenceEnabled) => {
    set((s) => {
      const c = s.byId[conversationId] ?? emptyConversation('direct');
      return {
        byId: { ...s.byId, [conversationId]: { ...c, persistenceEnabled } },
      };
    });
    void persist(get().byId);
  },

  setMuted: (conversationId, muted) => {
    set((s) => {
      const c = s.byId[conversationId] ?? emptyConversation('direct');
      return {
        byId: { ...s.byId, [conversationId]: { ...c, muted } },
      };
    });
    void persist(get().byId);
  },

  setFrozen: (conversationId, frozen) => {
    set((s) => {
      const c = s.byId[conversationId] ?? emptyConversation('direct');
      return {
        byId: { ...s.byId, [conversationId]: { ...c, frozen } },
      };
    });
    void persist(get().byId);
  },

  ttlSecondsFor: (conversationId) => {
    const c = get().byId[conversationId];
    if (!c) return DEFAULT_TTL_SECONDS;
    if (c.persistenceEnabled) return null;
    return TTL_OPTIONS[c.ttl];
  },

  markRead: (conversationId) => {
    set((s) => {
      const c = s.byId[conversationId];
      if (!c) return s;
      return {
        byId: { ...s.byId, [conversationId]: { ...c, lastReadAt: Date.now() } },
      };
    });
    void persist(get().byId);
  },

  unreadCountFor: (conversationId) => {
    const c = get().byId[conversationId];
    if (!c) return 0;
    if (!c.lastReadAt) return c.messages.length;
    // Count by ARRIVAL time (receivedAt), not sentAt. The server buffers
    // messages while the recipient is offline and relays them with their
    // original (old) sentAt; comparing sentAt > lastReadAt would silently
    // drop those late-delivered messages from the unread badge. receivedAt
    // is stamped on every add (see add()), so it reflects when the message
    // actually landed relative to the last read. This is the "unread
    // indicator" concern the localOrderKey docblock defers to here.
    return c.messages.filter((m) => (m.receivedAt ?? m.sentAt) > c.lastReadAt!)
      .length;
  },

  hydrate: async () => {
    // Scrub the legacy plaintext copy. Earlier builds persisted
    // decrypted history as cleartext JSON in AsyncStorage; deleting it
    // here removes that on-disk exposure on the first run of any build
    // that has this code. Idempotent — a no-op once it's gone. The old
    // history is intentionally not migrated into the encrypted store.
    void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    try {
      const raw = await secureKv.get(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ConversationState>;
        // Drop any messages whose TTL has already expired (the local
        // disappearing-message engine would have removed them mid-
        // session; same policy on cold start so the user doesn't see
        // resurrected expired bubbles).
        const now = Date.now();
        const filtered: Record<string, ConversationState> = {};
        for (const [id, c] of Object.entries(parsed)) {
          // Re-sort by send time. Builds before v1.0.10 persisted messages
          // in arrival (receivedAt) order, so a conversation that received
          // a late backlog batch is stored out of sent-order. Stable sort
          // (ms ties keep their stored order) corrects it on first load.
          const sorted = [...c.messages].sort((a, b) => a.sentAt - b.sentAt);
          if (c.persistenceEnabled) {
            filtered[id] = { ...c, messages: sorted };
            continue;
          }
          const ttlSec = TTL_OPTIONS[c.ttl];
          const ttlMs = ttlSec === null ? Infinity : ttlSec * 1000;
          filtered[id] = { ...c, messages: sorted.filter((m) => now - m.sentAt < ttlMs) };
        }
        set({ byId: filtered });
      }
    } catch {
      // Corrupt / missing → keep empty state.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ byId: {} });
    try {
      await secureKv.delete(STORAGE_KEY);
    } catch {
      /* ignore — pre-enrollment the DB isn't open; nothing to clear */
    }
    // Also clear any legacy plaintext copy, for the account-delete path.
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
