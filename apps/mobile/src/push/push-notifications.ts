/**
 * Push notification service — Phase 5d.
 *
 * Abstracts FCM/APNs token acquisition so the JS layer works in both
 * production (native module) and test (mock) environments, matching the
 * pattern used by VouchflowClient and SignalProtocolModule.
 */

export interface PushTokenResult {
  pushToken: string;
  platform: 'ios' | 'android';
}

export interface PushNotificationService {
  /**
   * Acquire the current push token from the OS. On Android this calls
   * `firebase.messaging().getToken()`; on iOS it calls the APNs equivalent.
   *
   * Returns `undefined` if the device doesn't support push or the user
   * hasn't granted notification permission yet. Callers should retry on
   * app foreground if undefined.
   */
  getToken(): Promise<PushTokenResult | undefined>;

  /**
   * Best-effort: start FCM token provisioning early, without a
   * permission prompt or a result. Call once at app launch so the
   * slow first-install provisioning overlaps onboarding instead of
   * racing a short first session.
   */
  warmUp(): Promise<void>;
}

/**
 * Production implementation — requires `@react-native-firebase/messaging`.
 * Falls back to Noop if the native module isn't available (e.g. CI
 * emulator without Play Services, or the package isn't linked).
 */
export class NativePushNotificationService implements PushNotificationService {
  /**
   * Last reason we returned `undefined`. Surfaced via `lastFailureReason`
   * so App.tsx can log the *specific* branch into the diag stream
   * instead of a generic "no token" message — earlier alphas reported
   * "firebase unlinked or permission denied" generically and we
   * couldn't tell which path was failing without rebuilding to add
   * one-off logs.
   */
  lastFailureReason: string | undefined;

  /**
   * Trigger FCM installation provisioning without requesting any
   * permission. The first `getToken()` on a fresh install is slow —
   * Google provisions the app installation over the network — and a
   * short first session can end before it finishes. Running this at
   * launch overlaps that work with onboarding so the real
   * `getToken()` later resolves from FCM's cache. Best-effort: a
   * failure here just means the real `getToken()` pays the cost.
   */
  async warmUp(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { NativeModules } = require('react-native') as {
        NativeModules: Record<string, unknown>;
      };
      if (
        !NativeModules.RNFBMessagingModule &&
        !NativeModules.RNFirebaseMessaging
      ) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const fcm = require('@react-native-firebase/messaging') as {
        getMessaging: () => unknown;
        getToken: (m: unknown) => Promise<string>;
      };
      await fcm.getToken(fcm.getMessaging());
    } catch {
      /* best-effort warm-up */
    }
  }

  async getToken(): Promise<PushTokenResult | undefined> {
    this.lastFailureReason = undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { NativeModules, PermissionsAndroid, Platform } = require(
        'react-native',
      ) as {
        NativeModules: Record<string, unknown>;
        PermissionsAndroid: {
          PERMISSIONS: { POST_NOTIFICATIONS?: string };
          RESULTS: { GRANTED: string };
          check: (perm: string) => Promise<boolean>;
          request: (perm: string) => Promise<string>;
        };
        Platform: { OS: string; Version: number };
      };

      // Android 13+ (API 33) requires POST_NOTIFICATIONS at runtime.
      // Without this, FCM accepts the message and the OS silently
      // drops the banner — every push from rc.27→rc.32 was lost
      // exactly because of this. Request once; subsequent calls return
      // immediately. Older Android versions don't expose the
      // permission key, so check before referencing it.
      if (
        Platform.OS === 'android' &&
        Platform.Version >= 33 &&
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      ) {
        const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
        const already = await PermissionsAndroid.check(perm);
        if (!already) {
          const result = await PermissionsAndroid.request(perm);
          if (result !== PermissionsAndroid.RESULTS.GRANTED) {
            this.lastFailureReason = `android_post_notifications_denied (${result})`;
            return undefined;
          }
        }
      }

      // Check if the Firebase Messaging native module is linked before
      // trying to import the JS wrapper — avoids a hard crash in Hermes
      // when the native module isn't available.
      if (!NativeModules.RNFBMessagingModule && !NativeModules.RNFirebaseMessaging) {
        const moduleKeys = Object.keys(NativeModules)
          .filter((k) => /^(RNFB|RNFirebase|Firebase)/i.test(k))
          .slice(0, 5);
        this.lastFailureReason = `native_module_missing (saw matching keys: ${moduleKeys.join(',') || 'none'})`;
        return undefined;
      }
      // @react-native-firebase/messaging v24+ — use the *modular* API.
      // The v6-style namespaced default (`messaging.default.messaging()`)
      // does not have a `.messaging` property, so calling it threw
      // "undefined is not a function" in rc.27 testing. Modular API
      // takes a messaging instance returned from `getMessaging()` and
      // operates on it via free functions.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const fcm = require('@react-native-firebase/messaging') as {
        getMessaging: () => unknown;
        getToken: (m: unknown) => Promise<string>;
        hasPermission: (m: unknown) => Promise<number>;
        requestPermission: (m: unknown) => Promise<number>;
      };
      const m = fcm.getMessaging();
      const authStatus = await fcm.hasPermission(m);
      // 1 = AUTHORIZED, 2 = PROVISIONAL (iOS quiet), 0 = DENIED, -1 = NOT_DETERMINED.
      // Android always returns AUTHORIZED from this call.
      if (authStatus !== 1 && authStatus !== 2) {
        const requested = await fcm.requestPermission(m);
        if (requested !== 1 && requested !== 2) {
          this.lastFailureReason = `permission_denied (status=${requested})`;
          return undefined;
        }
      }
      const token = await fcm.getToken(m);
      if (!token) {
        this.lastFailureReason = 'getToken_returned_empty';
        return undefined;
      }
      return { pushToken: token, platform: Platform.OS === 'ios' ? 'ios' : 'android' };
    } catch (err) {
      this.lastFailureReason = `exception: ${(err as Error).message ?? String(err)}`;
      return undefined;
    }
  }
}

/**
 * Mock for tests — always returns a fake token.
 */
export class MockPushNotificationService implements PushNotificationService {
  constructor(private readonly result?: PushTokenResult) {}

  async warmUp(): Promise<void> {}

  async getToken(): Promise<PushTokenResult | undefined> {
    return (
      this.result ?? {
        pushToken: 'mock-fcm-token',
        platform: 'android' as const,
      }
    );
  }
}

/**
 * Noop for builds that don't want push (e.g. Storybook).
 */
export class NoopPushNotificationService implements PushNotificationService {
  async warmUp(): Promise<void> {}

  async getToken(): Promise<PushTokenResult | undefined> {
    return undefined;
  }
}
