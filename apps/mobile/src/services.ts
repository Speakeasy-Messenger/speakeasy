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
import { diag } from './diag/log.js';
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

export function getWsClient(
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string>,
): SpeakeasyWsClient {
  if (!_ws) {
    _ws = new SpeakeasyWsClient({
      url: config.wsUrl,
      getToken,
      onState: (state) => useConnection.getState().setState(state),
      onClose: ({ code, reason, stateAtClose, intentional }) => {
        // diagnose rapid-cycle reproductions (rc.8 user report). Each
        // close logs (code, reason, state) so a Diagnostics dump shows
        // whether the close was `replaced` (4000) — implying parallel
        // socket from the same device — or something else.
        diag('ws', 'closed', { code, reason, stateAtClose, intentional });
      },
      onAuthRejected: async ({ reason }) => {
        // The server forgot this device's (token → userId) binding.
        // Rebuild it before the client reconnects, otherwise the WS
        // spins in `reconnecting` forever. Dynamic import avoids a
        // static cycle with ensure-enrolled.ts (which imports `api`).
        diag('ws', 'auth rejected — re-enrolling device', { reason });
        const { ensureServerBinding } = await import('./auth/ensure-enrolled.js');
        const result = await ensureServerBinding({ signalProtocol, vouchflow });
        diag('ws', 'auth-rejected re-enroll done', { result });
      },
    });
  }
  return _ws;
}
