import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { diag } from '../diag/log.js';

/**
 * Just-in-time runtime permission helpers.
 *
 * Speakeasy asks for mic and camera at the moment the user takes the
 * action that needs them (first call → mic, first photo capture / first
 * video call → camera). This avoids upfront permission-wall fatigue and
 * means the contextual reason is obvious when the OS prompt appears.
 *
 * iOS handles both via the system dialog raised by getUserMedia +
 * the picker — gated by the corresponding Info.plist strings — so
 * these helpers are Android-only and return `granted` on iOS without
 * touching the OS.
 *
 * Behavior on Android:
 *  - already-granted: returns 'granted', no prompt.
 *  - first time: shows the OS prompt, returns 'granted' or 'denied'.
 *  - previously denied with "Don't ask again": OS suppresses the
 *    prompt; we get 'never_ask_again' and surface an Alert that deep-
 *    links to app settings (the only way the user can change it).
 *
 * Callers should treat anything other than 'granted' as a hard stop —
 * the helper has already informed the user, so the caller just needs
 * to bail out cleanly (end the call, return null from the picker).
 */

export type PermissionResult = 'granted' | 'denied' | 'never_ask_again';

type PermKind = 'mic' | 'camera';

const COPY: Record<PermKind, { title: string; body: string }> = {
  mic: {
    title: 'Microphone access needed',
    body: 'Calls need access to your microphone. Open Settings to allow it.',
  },
  camera: {
    title: 'Camera access needed',
    body: 'This needs access to your camera. Open Settings to allow it.',
  },
};

async function ensure(kind: PermKind, perm: string): Promise<PermissionResult> {
  if (Platform.OS !== 'android') return 'granted';
  try {
    const already = await PermissionsAndroid.check(
      perm as Parameters<typeof PermissionsAndroid.check>[0],
    );
    if (already) {
      diag('perm', `${kind}: already granted`);
      return 'granted';
    }
    const result = await PermissionsAndroid.request(
      perm as Parameters<typeof PermissionsAndroid.request>[0],
    );
    diag('perm', `${kind}: requested`, { result });
    if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      showOpenSettingsAlert(kind);
      return 'never_ask_again';
    }
    return 'denied';
  } catch (err) {
    diag('perm', `${kind}: request threw`, { err: String(err) });
    return 'denied';
  }
}

export function ensureMicPermission(): Promise<PermissionResult> {
  // The RN types declare the PERMISSIONS map values as string|undefined
  // because the map is a generic dict, but RECORD_AUDIO and CAMERA are
  // both shipped in every supported Android version (since API 1 and
  // API 1 respectively) — coercing to string is safe.
  return ensure('mic', PermissionsAndroid.PERMISSIONS.RECORD_AUDIO as string);
}

export function ensureCameraPermission(): Promise<PermissionResult> {
  return ensure('camera', PermissionsAndroid.PERMISSIONS.CAMERA as string);
}

function showOpenSettingsAlert(kind: PermKind): void {
  const { title, body } = COPY[kind];
  Alert.alert(title, body, [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Open Settings',
      onPress: () => {
        void Linking.openSettings();
      },
    },
  ]);
}
