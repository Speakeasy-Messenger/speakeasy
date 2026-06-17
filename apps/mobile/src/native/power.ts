import { NativeModules, Platform } from 'react-native';

/**
 * Battery-optimization (Doze / App-Standby) exemption — maps to the
 * native `SpeakeasyPower` module (Android: power/PowerModule.kt).
 *
 * Speakeasy's 'rich' Android push is data-only so the headless FCM
 * handler can decrypt + render the real message text. A data-only message
 * needs that handler to run, and Android defers/kills it for a
 * battery-optimized app — so background pushes batch up and only appear on
 * the next foreground. Whitelisting the app lets high-priority pushes wake
 * it in the background (the standard Signal/WhatsApp fix).
 *
 * No-op on platforms without the native module (iOS — APNs handles its own
 * background delivery — vitest, web preview).
 */
interface SpeakeasyPowerModule {
  isIgnoringBatteryOptimizations: () => Promise<boolean>;
  requestDisableBatteryOptimization: () => Promise<boolean>;
}

function nativeModule(): SpeakeasyPowerModule | undefined {
  if (Platform.OS !== 'android') return undefined;
  return (NativeModules as { SpeakeasyPower?: SpeakeasyPowerModule }).SpeakeasyPower;
}

/**
 * Whether the app is already exempt from Android battery optimization.
 * When exempt, high-priority FCM pushes can wake the headless handler in
 * the background so notifications arrive on time instead of batching on
 * the next foreground.
 *
 * Returns `true` when the native module is unavailable (iOS, vitest, web)
 * — there's nothing to fix on those platforms, so callers treat it as
 * "already handled" and the in-app nudge stays hidden.
 */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  try {
    const mod = nativeModule();
    if (!mod) return true;
    return await mod.isIgnoringBatteryOptimizations();
  } catch {
    return true;
  }
}

/**
 * Show the system battery-optimization exemption dialog for this app.
 * Resolves `true` if a settings surface was opened, `false` off-Android or
 * if the OS refused both the direct request and the settings-list fallback.
 */
export async function requestDisableBatteryOptimization(): Promise<boolean> {
  try {
    return (await nativeModule()?.requestDisableBatteryOptimization()) ?? false;
  } catch {
    return false;
  }
}
