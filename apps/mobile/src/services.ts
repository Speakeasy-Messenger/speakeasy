import { ApiClient } from './api/client.js';
import { config } from './config.js';
import { NativeVouchflowClient, type VouchflowClient } from './native/vouchflow.js';
import { CachingVouchflowClient } from './native/caching-vouchflow.js';
import { MockSignalProtocolClient } from './native/mock-signal-protocol.js';
import {
  MockGroupMessagingClient,
  NativeGroupMessagingModule,
  NativeSignalProtocolModule,
  type GroupMessagingModule,
  type SignalProtocolModule,
} from '@speakeasy/crypto';
import { SpeakeasyWsClient } from './ws/client.js';
import { useConnection } from './store/connection.js';
import {
  NativePushNotificationService,
  type PushNotificationService,
} from './push/push-notifications.js';

/**
 * Module-level service singletons. Wires real implementations in the app.
 * Tests construct their own and don't import this file.
 */

export const api = new ApiClient({ baseUrl: config.apiBaseUrl });

/**
 * Vouchflow client. Always uses the real native bridge (SDK 2.0.0).
 * Wrapped in `CachingVouchflowClient` so back-to-back WS reconnects
 * don't trigger a fresh biometric prompt every time. Cache TTL is
 * intentionally below the server's 5-minute freshness window.
 *
 * MockVouchflowClient was removed in the SDK 2.0.0 integration — the
 * server now validates real device tokens via the Vouchflow API.
 */
export const vouchflow: VouchflowClient = new CachingVouchflowClient(
  new NativeVouchflowClient(),
);

/**
 * Signal Protocol client. Real native bridge by default; mock used when
 * `config.useMockSignalProtocol` is true (Storybook host or QA build where
 * libsignal is not linked into the APK).
 *
 * Native impl is `apps/mobile/android/.../signal/SignalProtocolModule.kt`,
 * backed by `org.signal:libsignal-android` and the SQLCipher-backed store
 * (Phase 5c). Identity persists across cold starts; subsequent
 * `generateIdentityKey()` calls return the existing public key rather than
 * minting a fresh one.
 */
export const signalProtocol: SignalProtocolModule = config.useMockSignalProtocol
  ? new MockSignalProtocolClient()
  : new NativeSignalProtocolModule();

/**
 * Group messaging client (Sender Keys). Mock when
 * `config.useMockSignalProtocol` (kept on the same toggle since they
 * share the underlying SignalProtocolStore — flipping one without the
 * other would mismatch). Group chat UX wiring + server fan-out wire
 * format are deferred — see spec §11 Phase 5b carry-over.
 */
export const groupMessaging: GroupMessagingModule = config.useMockSignalProtocol
  ? new MockGroupMessagingClient()
  : new NativeGroupMessagingModule();

/**
 * Push notification service (Phase 5d). Acquires FCM/APNs token and
 * uploads to server so offline recipients can be woken. Gracefully
 * degrades — if the device lacks Play Services or the user denies
 * notification permission, push is simply unavailable.
 */
export const pushNotifications: PushNotificationService = new NativePushNotificationService();

let _ws: SpeakeasyWsClient | undefined;

export function getWsClient(getToken: () => Promise<string>): SpeakeasyWsClient {
  if (!_ws) {
    _ws = new SpeakeasyWsClient({
      url: config.wsUrl,
      getToken,
      onState: (state) => useConnection.getState().setState(state),
    });
  }
  return _ws;
}
