import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  DEFAULT_TTL_SECONDS,
  TTL_OPTIONS,
  conversationIdForDirect,
  type Attachment,
  type ConversationKind,
  type TtlOption,
} from '@speakeasy/shared';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';

/**
 * Per-conversation message list + TTL config + persistence opt-in.
 *
 * Persisted to AsyncStorage so chat history survives app restarts
 * (matches user expectation; Tier B run 25213896438 caught the gap).
 * Spec §5 still says messages disappear by default — that's the local
 * TTL engine's job; persistence here just keeps undisappeared messages
 * across cold starts. Real SQLCipher migration lands when the native
 * shells are scaffolded (§4c).
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
  /** Conversation membership type — affects routing on outbound. */
  kind: ConversationKind;
  /** Wall-clock send time (ms). */
  sentAt: number;
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
}

interface ConversationsState {
  byId: Record<string, ConversationState>;
  /** True once `hydrate()` has run (loaded from disk on startup). */
  hydrated: boolean;
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
  remove: (conversationId: string, msgId: string) => void;
  /** Drop the entire conversation entry. Used by group leave (the
   * room disappears from the user's local list) and by 1:1 delete. */
  removeConversation: (conversationId: string) => void;
  setTtl: (conversationId: string, ttl: TtlOption) => void;
  setPersistence: (conversationId: string, on: boolean) => void;
  /** Toggle per-conversation notification suppression. */
  setMuted: (conversationId: string, muted: boolean) => void;
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

async function persist(byId: Record<string, ConversationState>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byId));
  } catch {
    // Persistence failure is non-fatal — in-memory state is the source
    // of truth for the current session.
  }
}

export const useConversations = create<ConversationsState>((set, get) => ({
  byId: {},
  hydrated: false,

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
      let peerUserId = c.peerUserId;
      if (msg.kind === 'direct' && !peerUserId && msg.from !== 'me') {
        peerUserId = msg.from;
      }
      return {
        byId: {
          ...s.byId,
          [conversationId]: {
            ...c,
            peerUserId,
            messages: [...c.messages, msg],
          },
        },
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
      if (!touched) return s;
      void persist(next);
      return { byId: next };
    }),

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
    return c.messages.filter((m) => m.sentAt > c.lastReadAt!).length;
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ConversationState>;
        // Drop any messages whose TTL has already expired (the local
        // disappearing-message engine would have removed them mid-
        // session; same policy on cold start so the user doesn't see
        // resurrected expired bubbles).
        const now = Date.now();
        const filtered: Record<string, ConversationState> = {};
        for (const [id, c] of Object.entries(parsed)) {
          if (c.persistenceEnabled) {
            filtered[id] = c;
            continue;
          }
          const ttlSec = TTL_OPTIONS[c.ttl];
          const ttlMs = ttlSec === null ? Infinity : ttlSec * 1000;
          const aliveMessages = c.messages.filter((m) => now - m.sentAt < ttlMs);
          filtered[id] = { ...c, messages: aliveMessages };
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
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
