import { Platform } from 'react-native';
import { diag } from '../diag/log.js';

/**
 * iOS VoIP push (PushKit) registration.
 *
 * The CallKit incoming-call experience has two halves:
 *   - NATIVE (AppDelegate.mm): a VoIP push wakes the app even from a killed
 *     state and `reportNewIncomingCall` is called synchronously in the push
 *     handler (iOS 13+ requirement) so the system shows the call UI. That part
 *     needs no JS to be alive.
 *   - JS (this module): registers the device's VoIP token with the server so
 *     it can target VoIP pushes, and — when a push arrives — prewarms the WS so
 *     the buffered `call_offer` drains and the orchestrator reaches
 *     `incoming_ringing` before the user answers. The CallKit answer/end
 *     buttons route through `callkeep-bridge` into the orchestrator.
 *
 * Android uses FCM high-importance call notifications instead (no PushKit), so
 * this is a no-op off iOS. The library is lazy-required (like the firebase /
 * callkeep shims) so a build without the native module can't crash at import.
 */

type VoipLib = {
  registerVoipToken: () => void;
  addEventListener: (
    event: 'register' | 'notification' | 'didLoadWithEvents',
    handler: (arg: unknown) => void,
  ) => void;
  removeEventListener: (event: string) => void;
  onVoipNotificationCompleted: (uuid: string) => void;
  RNVoipPushRemoteNotificationsRegisteredEvent: string;
  RNVoipPushRemoteNotificationReceivedEvent: string;
};

function tryLoadVoip(): VoipLib | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-voip-push-notification');
    const lib = (mod?.default ?? mod) as VoipLib | undefined;
    if (lib && typeof lib.registerVoipToken === 'function') return lib;
    return undefined;
  } catch (err) {
    diag('voip', 'lib load failed (non-fatal)', { err: String(err) });
    return undefined;
  }
}

export interface VoipPushDeps {
  /** Resolve the cached Vouchflow device token used as the API bearer. */
  getDeviceToken: () => string | undefined;
  /** POST the VoIP token to the server (api.registerVoipToken). */
  registerVoipToken: (deviceToken: string, voipToken: string) => Promise<void>;
  /** Connect/prewarm the WS so a buffered call_offer drains promptly. */
  prewarmForIncomingCall: () => Promise<void> | void;
}

let started = false;

/** Idempotent. Call once after enrollment, on iOS only. */
export function startVoipPush(deps: VoipPushDeps): void {
  if (Platform.OS !== 'ios' || started) return;
  const voip = tryLoadVoip();
  if (!voip) return;
  started = true;

  const sendToken = (token: string) => {
    const dt = deps.getDeviceToken();
    if (!dt || !token) return;
    deps
      .registerVoipToken(dt, token)
      .then(() => diag('voip', 'token registered'))
      .catch((err) => diag('voip', 'token register failed', { err: String(err) }));
  };

  const onNotification = (raw: unknown) => {
    const data = (raw ?? {}) as { uuid?: string; call_id?: string };
    const uuid = data.uuid ?? data.call_id;
    // Native already reported to CallKit; bring the WS up so the offer drains
    // and the orchestrator is ringing by the time the user answers.
    Promise.resolve(deps.prewarmForIncomingCall())
      .catch((err) => diag('voip', 'prewarm failed', { err: String(err) }))
      .finally(() => {
        // Tell PushKit we've finished handling the push (iOS requires this so
        // it doesn't think we failed to report a call).
        if (uuid) {
          try {
            voip.onVoipNotificationCompleted(uuid);
          } catch (err) {
            diag('voip', 'onVoipNotificationCompleted threw', { err: String(err) });
          }
        }
      });
  };

  voip.addEventListener('register', (token) => sendToken(String(token)));
  voip.addEventListener('notification', onNotification);

  // Events that fired before this JS handler mounted (the push that launched
  // the app). The native side buffers them and replays here.
  voip.addEventListener('didLoadWithEvents', (events) => {
    if (!Array.isArray(events)) return;
    for (const ev of events as Array<{ name: string; data: unknown }>) {
      if (ev?.name === voip.RNVoipPushRemoteNotificationsRegisteredEvent) {
        sendToken(String(ev.data));
      } else if (ev?.name === voip.RNVoipPushRemoteNotificationReceivedEvent) {
        onNotification(ev.data);
      }
    }
  });

  voip.registerVoipToken();
  diag('voip', 'registration started');
}
