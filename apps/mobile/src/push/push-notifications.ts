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
 * The native module is conditionally loaded so the test environment
 * (vitest / Node) doesn't crash on import.
 */
export class NativePushNotificationService implements PushNotificationService {
  async getToken(): Promise<PushTokenResult | undefined> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const rn = require('react-native') as { Platform?: { OS?: string } };
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
      // Check / request permission first.
      const authStatus = await m.hasPermission();
      // FirebaseMessaging.AuthorizationStatus.AUTHORIZED = 1
      if (authStatus !== 1 && authStatus !== 2) {
        const requested = await m.requestPermission();
        if (requested !== 1 && requested !== 2) return undefined;
      }
      const token = await m.getToken();
      if (!token) return undefined;
      const platform = rn.Platform?.OS === 'ios' ? 'ios' : 'android';
      return { pushToken: token, platform };
    } catch {
      // Native module not available (e.g. on emulator without Play Services)
      // or permission denied — silently degrade. Push is best-effort.
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
