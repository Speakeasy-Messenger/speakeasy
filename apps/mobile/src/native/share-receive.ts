import { NativeModules } from 'react-native';

/**
 * Drains text shared into the app via the system share sheet ("Share →
 * Speakeasy"). Both platforms expose a `SpeakeasyShare` native module with the
 * same shape: Android stashes the ACTION_SEND text from MainActivity; iOS
 * reads it from the App Group container the Share Extension wrote to. Resolves
 * null when nothing is pending or the module is unavailable.
 */
interface NativeShare {
  consumePendingShare(): Promise<{ text: string } | null>;
}

const native = (NativeModules as { SpeakeasyShare?: NativeShare }).SpeakeasyShare;

export async function consumePendingShare(): Promise<string | null> {
  if (!native) return null;
  try {
    const result = await native.consumePendingShare();
    return result?.text ?? null;
  } catch {
    return null;
  }
}
