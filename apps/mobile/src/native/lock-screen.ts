import { NativeModules, Platform } from 'react-native';

/**
 * Controls whether the Activity may appear over the lock screen and turn
 * the screen on — scoped to exactly when a call needs it.
 *
 * Background: Speakeasy used to declare `android:showWhenLocked="true"`
 * and `android:turnScreenOn="true"` statically on MainActivity so an
 * incoming call could ring over the lock screen. But static manifest
 * attributes apply to the whole app forever, so locking the device with
 * Speakeasy foregrounded and pressing power surfaced the chat list ON
 * TOP of the lock screen — a privacy leak. We removed the static
 * attributes and now toggle the same OS flags programmatically (the
 * Android-recommended API-27+ pattern) only while a call is
 * ringing/connected.
 *
 * `setShowWhenLocked` maps to the native `SpeakeasyLockScreen` module
 * (Android: lockscreen/LockScreenModule.kt). It is a no-op when the
 * native module isn't present (iOS — which uses CallKit's own lock-screen
 * UI — vitest, web preview), so callers don't need a platform guard.
 */

interface SpeakeasyLockScreenModule {
  setShowWhenLocked: (enabled: boolean) => void;
  isDeviceSecure: () => Promise<boolean>;
  openSecuritySettings: () => Promise<boolean>;
}

function nativeModule(): SpeakeasyLockScreenModule | undefined {
  if (Platform.OS !== 'android') return undefined;
  return (NativeModules as { SpeakeasyLockScreen?: SpeakeasyLockScreenModule })
    .SpeakeasyLockScreen;
}

/**
 * Whether the device has a secure lock — PIN, pattern, password, or an
 * enrolled biometric — which is exactly the "passkey" Vouchflow attestation
 * needs to reach the production confidence floor. Used by onboarding to
 * guide a lockless device to set one up (and to tell that apart from a
 * has-a-lock-but-otherwise-un-attestable device).
 *
 * Fails OPEN (returns true) when the native module is unavailable — iOS,
 * vitest, web preview — so we never show the "set up a lock" prompt to a
 * platform we can't actually check.
 */
export async function isDeviceSecure(): Promise<boolean> {
  try {
    const mod = nativeModule();
    if (!mod) return true;
    return await mod.isDeviceSecure();
  } catch {
    return true;
  }
}

/** Open the system security settings (set-credential flow on API 28+). */
export async function openSecuritySettings(): Promise<void> {
  try {
    await nativeModule()?.openSecuritySettings();
  } catch {
    // Best effort — if it can't open, the user can reach Settings manually.
  }
}

/**
 * Whether a given call stage may show over the lock screen. True for any
 * live call (incoming ringing, connecting, connected, or an outgoing call
 * the user placed before locking) and false otherwise — `idle`, `ended`,
 * or no call at all. Pure + exported so the leak fix has a regression
 * guard: a future stage rename or an accidental `'ended' → true` would
 * resurface the chat-list-over-lock-screen bug this replaced.
 */
export function shouldShowOverLockScreen(stage: string | undefined): boolean {
  return stage !== undefined && stage !== 'idle' && stage !== 'ended';
}

/**
 * Allow (true) or disallow (false) the app to show over the lock screen
 * and wake the screen. Call with `true` when a call starts ringing and
 * `false` when it ends. Safe to call repeatedly with the same value.
 */
export function setShowWhenLocked(enabled: boolean): void {
  try {
    nativeModule()?.setShowWhenLocked(enabled);
  } catch {
    // Best-effort: a missing/stale native module must never crash the
    // call flow. Worst case the over-lockscreen ring degrades, which is
    // strictly safer than the leak we're fixing.
  }
}
