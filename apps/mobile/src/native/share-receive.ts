import { NativeModules, Platform } from 'react-native';

/**
 * Drains text shared into the app via the Android system share sheet
 * ("Share → Speakeasy"). Backed by the native SpeakeasyShare module, which
 * stashes the ACTION_SEND text from MainActivity. Android-only; resolves null
 * elsewhere or when nothing is pending.
 */
interface NativeShare {
  consumePendingShare(): Promise<{ text: string } | null>;
}

const native = (NativeModules as { SpeakeasyShare?: NativeShare }).SpeakeasyShare;

export async function consumePendingShare(): Promise<string | null> {
  if (Platform.OS !== 'android' || !native) return null;
  try {
    const result = await native.consumePendingShare();
    return result?.text ?? null;
  } catch {
    return null;
  }
}
