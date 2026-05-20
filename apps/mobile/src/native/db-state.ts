import { NativeModules } from 'react-native';

/**
 * Bridge to the small bit of [SpeakeasyDb] state JS needs to observe.
 *
 * Currently one method: [consumeStoreResetFlag]. The native DB layer
 * sets a one-shot "the local store was reset" flag whenever it deletes
 * the encrypted file outside of a user-initiated wipe — either the
 * upgrade-time orphan cleanup (first launch on a build with a fresh
 * key-derivation scheme) or the lost-key recovery branch (the rare
 * Keystore-corruption case). JS reads-and-clears the flag at startup
 * and surfaces a banner / diag entry, so a wipe is never silent.
 *
 * Returns `false` on:
 *  - every normal launch
 *  - a fresh install with no prior DB
 *  - test runs where the native module isn't loaded
 */
interface NativeSpeakeasyDb {
  consumeResetFlag(): Promise<boolean>;
}

const native = (NativeModules as { SpeakeasyDb?: NativeSpeakeasyDb }).SpeakeasyDb;

export async function consumeStoreResetFlag(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.consumeResetFlag();
  } catch {
    return false;
  }
}
