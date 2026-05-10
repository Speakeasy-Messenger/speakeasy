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
 *
 * Implementation note: react-native is loaded via `require` inside
 * each call rather than a top-level `import`. The package's ESM
 * shape includes Flow `import typeof` syntax that vitest's parser
 * (rollup) chokes on, even though the bundler (Metro) handles it.
 * Lazy require keeps these helpers callable from any module without
 * dragging the whole RN parse into the unit-test transform graph.
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

interface RnSurface {
  Platform: { OS: string };
  PermissionsAndroid: {
    PERMISSIONS: { CAMERA: string; RECORD_AUDIO: string };
    RESULTS: { GRANTED: string; DENIED: string; NEVER_ASK_AGAIN: string };
    check: (perm: string) => Promise<boolean>;
    request: (perm: string) => Promise<string>;
  };
  Alert: {
    alert: (
      title: string,
      message?: string,
      buttons?: Array<{ text: string; style?: string; onPress?: () => void }>,
    ) => void;
  };
  Linking: { openSettings: () => Promise<void> };
}

function rn(): RnSurface {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('react-native') as RnSurface;
}

async function ensure(kind: PermKind, perm: string): Promise<PermissionResult> {
  const { Platform, PermissionsAndroid } = rn();
  if (Platform.OS !== 'android') return 'granted';
  try {
    const already = await PermissionsAndroid.check(perm);
    if (already) {
      diag('perm', `${kind}: already granted`);
      return 'granted';
    }
    const result = await PermissionsAndroid.request(perm);
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
  return ensure('mic', rn().PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
}

export function ensureCameraPermission(): Promise<PermissionResult> {
  return ensure('camera', rn().PermissionsAndroid.PERMISSIONS.CAMERA);
}

function showOpenSettingsAlert(kind: PermKind): void {
  const { title, body } = COPY[kind];
  const { Alert, Linking } = rn();
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
