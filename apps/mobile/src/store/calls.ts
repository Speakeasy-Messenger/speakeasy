import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { ActiveCall, CallEndedReason } from '../calls/types.js';

const STORAGE_KEY = 'speakeasy.calls.v1';
/** Cap on persisted history. Old entries roll off the end. */
const HISTORY_LIMIT = 100;

export interface CallHistoryEntry {
  callId: string;
  peerUserId: string;
  isCaller: boolean;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  reason: CallEndedReason;
}

interface CallsState {
  active: ActiveCall | undefined;
  history: CallHistoryEntry[];
  hydrated: boolean;
  setActive: (call: ActiveCall | undefined) => void;
  recordHistory: (entry: CallHistoryEntry) => void;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

async function persistHistory(entries: CallHistoryEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* in-memory state remains source of truth this session */
  }
}

/**
 * Voice-call store. `active` mirrors the orchestrator's state machine
 * for UI; `history` is the local debugging log of every call attempt.
 *
 * History is intentionally local-only — the server never sees a call
 * history because it never persists the signaling frames. Spec §1
 * "ephemeral by default" applies to messages; debug call history is a
 * deliberate, scoped exception flagged for the user-facing settings
 * screen so they can clear it.
 */
export const useCalls = create<CallsState>((set, get) => ({
  active: undefined,
  history: [],
  hydrated: false,

  setActive: (call) => set({ active: call }),

  recordHistory: (entry) => {
    set((s) => {
      const next = [entry, ...s.history].slice(0, HISTORY_LIMIT);
      void persistHistory(next);
      return { history: next };
    });
  },

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CallHistoryEntry[];
        if (Array.isArray(parsed)) set({ history: parsed });
      }
    } catch {
      /* corrupt persisted state is non-fatal */
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    set({ active: undefined, history: [], hydrated: true });
  },
}));
