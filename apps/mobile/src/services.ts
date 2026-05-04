import { ApiClient } from './api/client.js';
import { config } from './config.js';
import { NativeVouchflowClient, type VouchflowClient } from './native/vouchflow.js';
import { CachingVouchflowClient } from './native/caching-vouchflow.js';
import {
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
 * Vouchflow client (SDK 2.0.0). Always uses the real native bridge.
 * Tier B builds use sandbox keys + sandbox endpoint, where the SDK
 * supports emulators and records `confidence: medium` verifies without
 * hardware attestation. Wrapped in `CachingVouchflowClient` so
 * back-to-back WS reconnects don't trigger a fresh biometric prompt
 * every time.
 */
export const vouchflow: VouchflowClient = new CachingVouchflowClient(
  new NativeVouchflowClient(),
);

/**
 * Signal Protocol client. Always uses the real native bridge.
 * Identity persists across cold starts via SQLCipher-backed store.
 */
export const signalProtocol: SignalProtocolModule = new NativeSignalProtocolModule();

/**
 * Group messaging client (Sender Keys). Always uses the real native
 * bridge. Group chat UX wiring + server fan-out wire format are
 * deferred — see spec §11 Phase 5b carry-over.
 */
export const groupMessaging: GroupMessagingModule = new NativeGroupMessagingModule();

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
