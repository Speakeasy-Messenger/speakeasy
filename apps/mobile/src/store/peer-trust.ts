import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { SignalProtocolModule } from '@speakeasy/crypto';
import { clearSessionCacheFor } from '../crypto/session.js';

/**
 * Peers whose Signal identity key CHANGED under an existing session
 * (reinstall / new device). The dangerous property of that state is
 * that it fails ASYMMETRICALLY:
 *
 *   - INBOUND from the peer throws `untrusted_identity` (their new
 *     identity ≠ the pinned one) → visible as the "[identity changed —
 *     verify with peer]" bubble, or a silently dead incoming call.
 *   - OUTBOUND to the peer *succeeds locally* — the old session still
 *     exists, so encrypt never consults the new identity — and the
 *     ciphertext just vanishes on their end (no session to decrypt it).
 *
 * So the only reliable signal is inbound. This store records that
 * signal (from the message router and the call orchestrator) so the
 * SEND and CALL paths can gate on it and offer the trust-reset prompt
 * BEFORE encrypting into the void (diag 2026-08-07: two incoming calls
 * dead on UntrustedIdentityException, then an outgoing call's ICE
 * happily encrypted over the dead session with no prompt).
 *
 * Persisted: the flag must survive a restart — the peer's reinstall
 * doesn't un-happen when our process does.
 */

const STORAGE_KEY = 'speakeasy-peer-trust';

interface PeerTrustState {
  /** Peers with a pending identity change, → wall-clock ms first seen. */
  changedPeers: Record<string, number>;
  hydrated: boolean;
  isChanged: (peerUserId: string) => boolean;
  /** Returns true if this is a NEW mark (peer wasn't already flagged) —
   *  callers use it to alert once, not on every failed frame. */
  markChanged: (peerUserId: string) => boolean;
  clearChanged: (peerUserId: string) => void;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

async function persist(changedPeers: Record<string, number>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(changedPeers));
  } catch {
    // Non-fatal — in-memory state is the source of truth this session.
  }
}

export const usePeerTrust = create<PeerTrustState>((set, get) => ({
  changedPeers: {},
  hydrated: false,

  isChanged: (peerUserId) => !!get().changedPeers[peerUserId],

  markChanged: (peerUserId) => {
    if (get().changedPeers[peerUserId]) return false;
    set((s) => {
      const next = { ...s.changedPeers, [peerUserId]: Date.now() };
      void persist(next);
      return { changedPeers: next };
    });
    return true;
  },

  clearChanged: (peerUserId) =>
    set((s) => {
      if (!s.changedPeers[peerUserId]) return s;
      const { [peerUserId]: _gone, ...rest } = s.changedPeers;
      void persist(rest);
      return { changedPeers: rest };
    }),

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      set({
        changedPeers: raw ? (JSON.parse(raw) as Record<string, number>) : {},
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ changedPeers: {} });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));

/**
 * The one true recovery: wipe the pinned identity + session for the
 * peer (native), drop the JS session cache, and clear the pending
 * flag. The next send/call re-fetches their bundle and TOFU-pins the
 * new identity. Everything the old identity encrypted stays dead —
 * that's the protocol working, not a bug.
 */
export async function trustNewIdentity(
  signalProtocol: SignalProtocolModule,
  peerUserId: string,
): Promise<void> {
  await signalProtocol.resetPeer(peerUserId);
  clearSessionCacheFor(peerUserId);
  usePeerTrust.getState().clearChanged(peerUserId);
}
