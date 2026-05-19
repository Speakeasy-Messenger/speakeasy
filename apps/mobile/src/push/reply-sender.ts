/**
 * Headless inline-reply sender.
 *
 * When the user types a reply into a notification's RemoteInput field,
 * `notifee.onBackgroundEvent` fires in a headless JS context — no UI, no
 * foreground app. This module encrypts that reply and sends it over the
 * WebSocket, reusing the same `message` wire frame the chat screen uses.
 *
 * Why this works headlessly:
 *  - `signalProtocol.encrypt` is native; the SQLCipher Signal store
 *    opens from any Android context (proven by the rc.97 background
 *    decrypt). A Signal session with the peer already exists — they
 *    just messaged us — so no prekey fetch / session init is needed.
 *  - The Vouchflow device token is read from the persisted identity
 *    store; the WS authenticates with it.
 *
 * Kept free of `../services.js` imports so it's unit-testable without
 * loading native modules — the caller injects `encrypt` / `getWsClient`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encodePayload, newMessageId, type WsClientMsg } from '@speakeasy/shared';
import { utf8ToBytes, bytesToB64 } from '../utils/bytes.js';
import { diag } from '../diag/log.js';

/** Persist key of the `useIdentity` store — see store/identity.ts. */
const IDENTITY_KEY = 'speakeasy.identity.v1';

/** Minimal WS surface the sender needs — lets tests pass a mock. */
export interface ReplyWsClient {
  connect(): void;
  waitForAuthed(timeoutMs?: number): Promise<void>;
  enqueueSend(msg: WsClientMsg): void;
}

export interface ReplySenderDeps {
  encrypt(peerUserId: string, plaintext: Uint8Array): Promise<Uint8Array>;
  getWsClient(getToken: () => Promise<string>): ReplyWsClient;
  loadDeviceToken(): Promise<string | undefined>;
  /** Socket flush grace before the headless task ends. Default 1500ms. */
  settleMs?: number;
}

// The Vouchflow device token is no longer read from here: it is a
// bearer-like credential and lives only in the SDK's native secure
// storage. The headless reply path gets it via `loadDeviceToken`, which
// `push-handler.ts` wires to `getCachedDeviceToken()`.

/** Read the local user's id from the persisted identity store. */
export async function loadPersistedUserId(): Promise<string | undefined> {
  try {
    const raw = await AsyncStorage.getItem(IDENTITY_KEY);
    if (!raw) return undefined;
    return (JSON.parse(raw) as { userId?: string }).userId;
  } catch {
    return undefined;
  }
}

/**
 * Encrypt `text` for `peerId` and send it as a direct message. Throws on
 * any failure (no token, encrypt error, WS auth timeout) so the caller
 * can surface a "couldn't send" state on the notification.
 */
export async function sendReplyMessage(
  peerId: string,
  text: string,
  deps: ReplySenderDeps,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty_reply');

  const deviceToken = await deps.loadDeviceToken();
  if (!deviceToken) throw new Error('no_device_token');

  const plaintext = encodePayload({ v: 1, text: trimmed });
  const ciphertext = await deps.encrypt(peerId, utf8ToBytes(plaintext));

  const ws = deps.getWsClient(async () => deviceToken);
  ws.connect();
  await ws.waitForAuthed();
  ws.enqueueSend({
    type: 'message',
    to: peerId,
    ciphertext: bytesToB64(ciphertext),
    msg_type: 'direct',
    message_id: newMessageId(),
  });
  diag('push-reply', 'inline reply sent', { peerId });

  // Let the socket flush before the headless task tears the JS context
  // down. `enqueueSend` hands the frame to the socket synchronously
  // once authed; this grace covers the TCP flush.
  await new Promise((r) => setTimeout(r, deps.settleMs ?? 1500));
}
