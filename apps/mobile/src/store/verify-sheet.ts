import { create } from 'zustand';
import {
  DeviceVerificationCancelledError,
  type VerificationReason,
} from '../auth/verify-device-types.js';
import type { FallbackReason } from '../native/vouchflow.js';

interface PendingPrompt {
  reason: VerificationReason;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PendingFallback {
  reason: FallbackReason;
  resolve: (deviceToken: string) => void;
  reject: (err: Error) => void;
}

interface VerifySheetState {
  /** Non-null while the branded sheet should be visible. */
  pending: PendingPrompt | undefined;
  /**
   * Non-null once the passkey attempt has failed and the sheet is
   * showing the email fallback instead. `pending` stays set the whole
   * time so the sheet never flickers closed between the two steps.
   */
  fallback: PendingFallback | undefined;
  /** Bumped on each request so re-prompting the same reason re-runs the animation. */
  nonce: number;
  request: (reason: VerificationReason) => Promise<void>;
  confirm: () => void;
  cancel: () => void;
  /**
   * `verify-device.ts` calls this when the passkey attempt fails —
   * `pending` is left set (so the sheet stays visible) while the sheet
   * component switches to rendering `EmailVerifyFallback`. Resolves
   * with the device token once that flow completes.
   */
  requestFallback: (reason: FallbackReason) => Promise<string>;
  /** The sheet calls this once the email path yields a device token. */
  resolveFallback: (deviceToken: string) => void;
  /** Clears visibility after a passkey-only success (no fallback ever opened). */
  finish: () => void;
}

/**
 * Coordinator for the <VerifyDeviceSheet> bottom sheet. Replaces the
 * stock `Alert.alert` that used to gate `vouchflow.verify()` with an
 * in-app branded modal mounted at the navigator root.
 *
 * Imperative `request(reason)` returns a Promise that resolves when the
 * user taps Continue and rejects with DeviceVerificationCancelledError
 * on Not-now, scrim tap, or Android back. `verify-device.ts` owns the
 * single-flight + cooldown bookkeeping and the actual `vouchflow.verify()`
 * attempt; this store delivers the confirmation gesture and — when that
 * attempt fails — bridges to the email fallback the sheet renders
 * inline, so a passkey-less device is never dead-ended.
 */
export const useVerifySheet = create<VerifySheetState>((set, get) => ({
  pending: undefined,
  fallback: undefined,
  nonce: 0,
  request(reason) {
    return new Promise<void>((resolve, reject) => {
      set((s) => ({
        pending: { reason, resolve, reject },
        fallback: undefined,
        nonce: s.nonce + 1,
      }));
    });
  },
  confirm() {
    const p = get().pending;
    if (!p) return;
    // Deliberately does NOT clear `pending` — the sheet stays visible
    // (in a "verifying" state) until `finish()` or `resolveFallback()`
    // says the whole thing is done.
    p.resolve();
  },
  cancel() {
    const f = get().fallback;
    if (f) {
      set({ pending: undefined, fallback: undefined });
      f.reject(new DeviceVerificationCancelledError());
      return;
    }
    const p = get().pending;
    if (p) {
      set({ pending: undefined, fallback: undefined });
      p.reject(new DeviceVerificationCancelledError());
    }
  },
  requestFallback(reason) {
    return new Promise<string>((resolve, reject) => {
      set({ fallback: { reason, resolve, reject } });
    });
  },
  resolveFallback(deviceToken) {
    const f = get().fallback;
    if (!f) return;
    set({ pending: undefined, fallback: undefined });
    f.resolve(deviceToken);
  },
  finish() {
    set({ pending: undefined, fallback: undefined });
  },
}));
