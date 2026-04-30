import { create } from 'zustand';
import {
  DEFAULT_TTL_SECONDS,
  TTL_OPTIONS,
  conversationIdForDirect,
  type ConversationKind,
  type TtlOption,
} from '@speakeasy/shared';
import type { DisappearingStage } from '../components/DisappearingMessageBubble.js';

/**
 * Per-conversation message list + TTL config + persistence opt-in.
 * Phase 3 scope: in-memory only; real persistence lands with SQLCipher when
 * native shells are scaffolded (spec §4c).
 */

export interface ChatMessage {
  /** Server-assigned message id (ULID). */
  id: string;
  /** Sender's adjective-adjective-noun id, or 'me' for the local user. */
  from: string;
  /**
   * Display text. Phase 1 mobile receives base64 ciphertext; real decrypt
   * fills this in when the Signal Protocol native module ships. Until then
   * we render the ciphertext verbatim so the layout can be exercised.
   */
  text: string;
  /** Conversation membership type — affects routing on outbound. */
  kind: ConversationKind;
  /** Wall-clock send time (ms). */
  sentAt: number;
  /** Animated dissolve stage; updated by the local TTL engine. */
  stage: DisappearingStage;
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
}

interface ConversationsState {
  byId: Record<string, ConversationState>;
  /**
   * Open (or refresh) a 1:1 conversation with `peerUserId`. Idempotent —
   * doesn't reset messages or settings if the conversation already exists.
   * Returns the conversationId for navigation.
   */
  openDirect: (myUserId: string, peerUserId: string) => string;
  add: (conversationId: string, msg: ChatMessage) => void;
  setStage: (conversationId: string, msgId: string, stage: DisappearingStage) => void;
  remove: (conversationId: string, msgId: string) => void;
  setTtl: (conversationId: string, ttl: TtlOption) => void;
  setPersistence: (conversationId: string, on: boolean) => void;
  /** Resolved TTL in seconds, or `null` if `off` / persistence is on. */
  ttlSecondsFor: (conversationId: string) => number | null;
  reset: () => void;
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

export const useConversations = create<ConversationsState>((set, get) => ({
  byId: {},

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
    return id;
  },

  add: (conversationId, msg) =>
    set((s) => {
      const existing = s.byId[conversationId];
      const c = existing ?? emptyConversation(msg.kind);
      // For inbound direct messages, ensure peerUserId is set so the
      // ConversationsScreen list can render this row. The router calls
      // add() before any explicit openDirect() may have happened (e.g.
      // self-DM, or a fresh peer messaging us first). Without this the
      // row exists in byId but is filtered out of the list view because
      // it has no peerUserId. `msg.from === 'me'` only happens for the
      // local optimistic echo in ChatScreen.handleSend; the inbound
      // path from the router always carries the actual sender id.
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
    }),

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

  remove: (conversationId, msgId) =>
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
    }),

  setTtl: (conversationId, ttl) =>
    set((s) => {
      const c = s.byId[conversationId] ?? emptyConversation('direct');
      return { byId: { ...s.byId, [conversationId]: { ...c, ttl } } };
    }),

  setPersistence: (conversationId, persistenceEnabled) =>
    set((s) => {
      const c = s.byId[conversationId] ?? emptyConversation('direct');
      return {
        byId: { ...s.byId, [conversationId]: { ...c, persistenceEnabled } },
      };
    }),

  ttlSecondsFor: (conversationId) => {
    const c = get().byId[conversationId];
    if (!c) return DEFAULT_TTL_SECONDS;
    if (c.persistenceEnabled) return null;
    return TTL_OPTIONS[c.ttl];
  },

  reset: () => set({ byId: {} }),
}));
