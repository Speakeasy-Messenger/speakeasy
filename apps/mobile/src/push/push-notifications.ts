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

  async getToken(): Promise<PushTokenResult | undefined> {
    this.lastFailureReason = undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { NativeModules, Platform } = require('react-native') as {
        NativeModules: Record<string, unknown>;
        Platform: { OS: string };
      };
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
  async getToken(): Promise<PushTokenResult | undefined> {
    return undefined;
  }
}
