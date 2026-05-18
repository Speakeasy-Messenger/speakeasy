import { NativeModules } from 'react-native';

/**
 * Single source of truth for the app's version.
 *
 * The values are baked into the APK at build time from the git tag
 * (see apps/mobile/android/app/build.gradle `deriveVersionString`)
 * and exposed to JS via the native `SpeakeasyVersion` module. This
 * file is the only place JS reads them from — every consumer
 * (`AboutScreen`, feedback submission, future telemetry) calls
 * `appVersion()` / `appBuild()` from here.
 *
 * Replaces the previous "manually edit 4 places before every release"
 * dance:
 *   - apps/mobile/android/app/build.gradle: versionName + versionCode
 *   - apps/mobile/src/screens/AboutScreen.tsx: APP_VERSION + APP_BUILD
 *
 * Now: bump the git tag, that's it.
 *
 * Why functions instead of constants:
 *   - At module load time on a real device, NativeModules is populated.
 *     A `const APP_VERSION = readNative()` captured at load is fine.
 *   - In vitest, multiple test files share a worker and the
 *     `react-native` mock can be re-initialized between them. A
 *     load-time constant captures whatever was registered at the
 *     first file's import, which may not match what a later test
 *     expects. Function-call form re-reads on each invocation.
 *   - The cost is one Platform.OS check + one property read per call.
 *     Render paths call this at most once per About screen mount and
 *     once per feedback submission — negligible.
 *
 * Fallback policy:
 *   - On native: BuildConfig via VersionModule. If the module isn't
 *     registered (stale Metro bundle against older APK), fall back
 *     to 'unknown' so the field is visibly wrong rather than silently
 *     reporting a stale hardcoded value.
 *   - On non-native (vitest, web preview): "0.0.0-test" so tests don't
 *     have to mock a native module just to read a string.
 */

interface SpeakeasyVersionModule {
  readonly versionName: string;
  readonly versionCode: number;
}

function readNativeVersion(): { name: string; build: string } {
  // Both platforms register the `SpeakeasyVersion` native module
  // (Android: VersionModule.kt; iOS: SpeakeasyBridges/Version).
  const mod = (NativeModules as { SpeakeasyVersion?: SpeakeasyVersionModule })
    .SpeakeasyVersion;
  if (!mod) {
    // No native module — a non-native context (vitest, web preview)
    // or a stale Metro bundle against an older binary. Either way the
    // value is visibly not a real version.
    return { name: '0.0.0-test', build: '0' };
  }
  return {
    name: mod.versionName,
    build: String(mod.versionCode),
  };
}

/**
 * Human-readable version e.g. "0.5.0-rc.82". Used in the About screen
 * and as the `app_version` field on submitted feedback so user bug
 * reports tie to a specific build.
 */
export function appVersion(): string {
  return readNativeVersion().name;
}

/**
 * Integer build identifier matching Android's `versionCode`, as a
 * string. Used by the About screen footer; matches the rc number for
 * tagged releases (rc.82 → "82") and is "0" for dev builds with no
 * rc number.
 */
export function appBuild(): string {
  return readNativeVersion().build;
}
