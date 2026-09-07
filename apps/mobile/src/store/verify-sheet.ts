import { create } from 'zustand';
import {
  DeviceVerificationCancelledError,
  type VerificationReason,
} from '../auth/verify-device-types.js';

interface PendingPrompt {
  reason: VerificationReason;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface VerifySheetState {
  pending: PendingPrompt | undefined;
  error: string | undefined;
  verificationInFlight: boolean;
  nonce: number;
  request: (reason: VerificationReason) => Promise<void>;
  confirm: () => void;
  cancel: () => void;
  fail: (message: string) => void;
  finish: () => void;
}

/** Keeps a failed verification visible until dismissed; the auth caller rejects immediately. */
export const useVerifySheet = create<VerifySheetState>((set, get) => ({
  pending: undefined,
  error: undefined,
  verificationInFlight: false,
  nonce: 0,
  request(reason) {
    return new Promise<void>((resolve, reject) => {
      set((s) => ({
        pending: { reason, resolve, reject },
        error: undefined,
        verificationInFlight: false,
        nonce: s.nonce + 1,
      }));
    });
  },
  confirm() {
    const p = get().pending;
    if (!p || get().verificationInFlight || get().error) return;
    set({ verificationInFlight: true });
    p.resolve();
  },
  cancel() {
    if (get().verificationInFlight) return;
    const p = get().pending;
    set({ pending: undefined, error: undefined, verificationInFlight: false });
    p?.reject(new DeviceVerificationCancelledError());
  },
  fail(error) {
    set({ error, verificationInFlight: false });
  },
  finish() {
    set({ pending: undefined, error: undefined, verificationInFlight: false });
  },
}));
