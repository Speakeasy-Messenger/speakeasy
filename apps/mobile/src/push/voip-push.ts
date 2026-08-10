import { Platform } from 'react-native';
import { diag } from '../diag/log.js';

type VoipEvent = { name?: string; data?: unknown };

type VoipLib = {
  registerVoipToken: () => void;
  addEventListener: (
    event: 'register' | 'notification' | 'didLoadWithEvents',
    handler: (arg: unknown) => void,
  ) => void;
  RNVoipPushRemoteNotificationsRegisteredEvent: string;
  RNVoipPushRemoteNotificationReceivedEvent: string;
};

export interface VoipPushDeps {
  getDeviceToken: () => string | undefined;
  registerVoipToken: (deviceToken: string, voipToken: string) => Promise<void>;
  prewarmForIncomingCall: () => Promise<void> | void;
}

let started = false;

function tryLoadVoip(): VoipLib | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('react-native-voip-push-notification');
    const lib = (mod?.default ?? mod) as VoipLib | undefined;
    return lib && typeof lib.registerVoipToken === 'function' ? lib : undefined;
  } catch (err) {
    diag('voip', 'native module unavailable', { err: String(err) });
    return undefined;
  }
}

/**
 * Register PushKit independently of ordinary notification permission. CallKit
 * ringing must still work when a user denied banner notifications, so this is
 * started before the FCM/APNs banner-token request.
 */
export function startVoipPush(deps: VoipPushDeps): void {
  if (Platform.OS !== 'ios' || started) return;
  const voip = tryLoadVoip();
  if (!voip) return;
  started = true;

  const sendToken = (raw: unknown) => {
    const voipToken = String(raw ?? '');
    const deviceToken = deps.getDeviceToken();
    if (!deviceToken || !voipToken) return;
    void deps
      .registerVoipToken(deviceToken, voipToken)
      .then(() => diag('voip', 'token registered'))
      .catch((err) => diag('voip', 'token registration failed', { err: String(err) }));
  };

  const onNotification = (raw: unknown) => {
    const data = (raw ?? {}) as { call_id?: string; call_uuid?: string };
    diag('voip', 'incoming push received', {
      hasCallId: !!data.call_id,
      hasCallUuid: !!data.call_uuid,
    });
    // Native has already reported CallKit. JS only needs to reconnect so the
    // buffered encrypted offer reaches the orchestrator before answer.
    void Promise.resolve(deps.prewarmForIncomingCall()).catch((err) =>
      diag('voip', 'websocket prewarm failed', { err: String(err) }),
    );
  };

  voip.addEventListener('register', sendToken);
  voip.addEventListener('notification', onNotification);
  voip.addEventListener('didLoadWithEvents', (raw) => {
    if (!Array.isArray(raw)) return;
    for (const event of raw as VoipEvent[]) {
      if (event.name === voip.RNVoipPushRemoteNotificationsRegisteredEvent) {
        sendToken(event.data);
      } else if (event.name === voip.RNVoipPushRemoteNotificationReceivedEvent) {
        onNotification(event.data);
      }
    }
  });

  voip.registerVoipToken();
  diag('voip', 'registration started');
}

/** Test-only reset for module-level registration state. */
export function __resetVoipPushForTests(): void {
  started = false;
}
