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
  async getToken(): Promise<PushTokenResult | undefined> {
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
        return undefined;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const messaging = require('@react-native-firebase/messaging') as {
        default: {
          messaging: () => {
            getToken: () => Promise<string>;
            hasPermission: () => Promise<number>;
            requestPermission: () => Promise<number>;
          };
        };
      };
      const m = messaging.default.messaging();
      const authStatus = await m.hasPermission();
      if (authStatus !== 1 && authStatus !== 2) {
        const requested = await m.requestPermission();
        if (requested !== 1 && requested !== 2) return undefined;
      }
      const token = await m.getToken();
      if (!token) return undefined;
      return { pushToken: token, platform: Platform.OS === 'ios' ? 'ios' : 'android' };
    } catch {
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
