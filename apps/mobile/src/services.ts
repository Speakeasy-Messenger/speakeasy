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

/**
 * Return the existing WS singleton WITHOUT creating one. Used by the
 * background call-push handler to pre-warm the connection only when the
 * app is already alive (so its orchestrator is wired to receive the
 * offer); a fresh headless context has no `_ws` and we let the
 * foreground bring it up normally.
 */
export function peekWsClient(): SpeakeasyWsClient | undefined {
  return _ws;
}

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
        // spins in `reconnecting` forever. forceReenroll skips the
        // REST probe inside ensureServerBinding — that probe is a
        // false-positive sensor (returns 200 even when the WS-side
        // binding is missing), and the WS just authoritatively told
        // us the binding is gone. Dynamic import avoids a static
        // cycle with ensure-enrolled.ts (which imports `api`).
        diag('ws', 'auth rejected — re-enrolling device', { reason });
        const { ensureServerBinding } = await import('./auth/ensure-enrolled.js');
        const result = await ensureServerBinding({
          signalProtocol,
          vouchflow,
          forceReenroll: true,
        });
        diag('ws', 'auth-rejected re-enroll done', { result });
      },
      // Phase 5j Private Call: report which call kinds this device
      // can answer on every reconnect. The native filter readiness
      // gates 'private' on/off so a downgrade (filter binary removed)
      // shrinks the set immediately. Lazy import dodges the JS-side
      // crash if voice-filter.ts's NativeModules read throws under a
      // test runtime — same defensive pattern as ensure-enrolled.
      getSupportedCallKinds: () => {
        // Inline require: the native module lookup happens at module
        // load and would otherwise crash test envs that import this
        // file before mocking NativeModules.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isPrivateCallAvailable } = require('./native/voice-filter.js') as {
          isPrivateCallAvailable: () => boolean;
        };
        return isPrivateCallAvailable()
          ? (['audio', 'video', 'private'] as const)
          : (['audio', 'video'] as const);
      },
    });
  }
  return _ws;
}
