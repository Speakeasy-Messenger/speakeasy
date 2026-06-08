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
import { diag, diagFingerprint } from '../diag/log.js';

/** Persist key of the `useIdentity` store — see store/identity.ts. */
const IDENTITY_KEY = 'speakeasy.identity.v1';

/** Minimal WS surface the sender needs — lets tests pass a mock. */
export interface ReplyWsClient {
  connect(): void;
  waitForAuthed(timeoutMs?: number): Promise<void>;
  enqueueSend(msg: WsClientMsg): void;
  queueSend?(msg: WsClientMsg, timeoutMs?: number): Promise<void>;
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
 *
 * Returns the `message_id` that went out on the wire. The caller MUST
 * record the in-app copy of the reply under this same id — read receipts
 * the peer sends back reference the wire id, so a locally-minted second
 * id would leave inline replies permanently un-receipted.
 */
export async function sendReplyMessage(
  peerId: string,
  text: string,
  deps: ReplySenderDeps,
): Promise<{ messageId: string }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty_reply');

  const deviceToken = await deps.loadDeviceToken();
  if (!deviceToken) throw new Error('no_device_token');

  const plaintext = encodePayload({ v: 1, text: trimmed });
  const ciphertext = await deps.encrypt(peerId, utf8ToBytes(plaintext));

  const ws = deps.getWsClient(async () => deviceToken);
  ws.connect();
  await ws.waitForAuthed();
  const messageId = newMessageId();
  const frame: WsClientMsg = {
    type: 'message',
    to: peerId,
    ciphertext: bytesToB64(ciphertext),
    msg_type: 'direct',
    message_id: messageId,
  };
  if (ws.queueSend) {
    await ws.queueSend(frame);
  } else {
    ws.enqueueSend(frame);
  }
  diag('push-reply', 'inline reply sent', { peerFp: diagFingerprint(peerId) });

  // Let the socket flush before the headless task tears the JS context
  // down. `enqueueSend` hands the frame to the socket synchronously
  // once authed; this grace covers the TCP flush.
  await new Promise((r) => setTimeout(r, deps.settleMs ?? 1500));
  return { messageId };
}

/** Deps for a headless GROUP inline reply — the orchestrator is injected
 * so this module stays free of `../services.js` (unit-testable with a
 * mock send). */
export interface GroupReplySenderDeps {
  /** The group send orchestrator's `sendGroupMessage` (does SKDM
   * bootstrap → encryptForGroup → `message` frame with msg_type='group'). */
  sendGroupMessage(opts: {
    groupId: string;
    members: string[];
    selfUserId: string;
    plaintext: Uint8Array;
  }): Promise<void>;
  /** Current group members (incl. self — the orchestrator filters self out). */
  members: string[];
  selfUserId: string;
  /** Socket flush grace before the headless task ends. Default 1500ms. */
  settleMs?: number;
}

/**
 * Encrypt `text` for the group and fan it out via the orchestrator. Used
 * by the headless inline-reply path — group sends are now reachable from
 * a background task because the SenderKey store (SQLCipher), the per-group
 * distributionId (AsyncStorage), and the member list (groups store) all
 * open from any Android context.
 *
 * Returns a locally-minted `messageId` for the in-app echo. Group message
 * frames don't carry a client message_id (the foreground send mints a
 * local echo id the same way), so this id is for the local record only.
 */
export async function sendGroupReplyMessage(
  groupId: string,
  text: string,
  deps: GroupReplySenderDeps,
): Promise<{ messageId: string }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty_reply');

  const plaintext = encodePayload({ v: 1, text: trimmed });
  await deps.sendGroupMessage({
    groupId,
    members: deps.members,
    selfUserId: deps.selfUserId,
    plaintext: utf8ToBytes(plaintext),
  });
  const messageId = newMessageId();
  diag('push-reply', 'inline group reply sent', { groupId });

  await new Promise((r) => setTimeout(r, deps.settleMs ?? 1500));
  return { messageId };
}
