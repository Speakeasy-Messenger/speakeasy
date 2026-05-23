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
  /** Non-null while the branded sheet should be visible. */
  pending: PendingPrompt | undefined;
  /** Bumped on each request so re-prompting the same reason re-runs the animation. */
  nonce: number;
  request: (reason: VerificationReason) => Promise<void>;
  confirm: () => void;
  cancel: () => void;
}

/**
 * Coordinator for the <VerifyDeviceSheet> bottom sheet. Replaces the
 * stock `Alert.alert` that used to gate `vouchflow.verify()` with an
 * in-app branded modal mounted at the navigator root.
 *
 * Imperative `request(reason)` returns a Promise that resolves when the
 * user taps Continue and rejects with DeviceVerificationCancelledError
 * on Not-now, scrim tap, or Android back. verify-device.ts owns the
 * single-flight + cooldown bookkeeping; this store just delivers the
 * confirmation gesture.
 */
export const useVerifySheet = create<VerifySheetState>((set, get) => ({
  pending: undefined,
  nonce: 0,
  request(reason) {
    return new Promise<void>((resolve, reject) => {
      set((s) => ({
        pending: { reason, resolve, reject },
        nonce: s.nonce + 1,
      }));
    });
  },
  confirm() {
    const p = get().pending;
    if (!p) return;
    set({ pending: undefined });
    p.resolve();
  },
  cancel() {
    const p = get().pending;
    if (!p) return;
    set({ pending: undefined });
    p.reject(new DeviceVerificationCancelledError());
  },
}));
