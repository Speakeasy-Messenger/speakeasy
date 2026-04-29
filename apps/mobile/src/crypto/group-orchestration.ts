import type { ApiClient } from '../api/client.js';
import type { GroupMessagingModule, SignalProtocolModule } from '@speakeasy/crypto';
import type { SpeakeasyWsClient } from '../ws/client.js';
import { ensureSessionWithPeer } from './session.js';
import { b64ToBytes, bytesToB64, utf8ToBytes } from '../utils/bytes.js';

/**
 * Send-side orchestration for group messaging (Phase 5b carry-over).
 *
 * # Flow
 *
 *   sendGroupMessage(group, plaintext, members):
 *     1. Look up (or mint) the local distributionId for (self, group).
 *     2. For each member !== self that hasn't yet been bootstrapped:
 *        a. Ensure a 1:1 Signal session exists with the member.
 *        b. Generate the SKDM (or reuse the existing one — the native
 *           bridge persists per-(self, group) state in SQLCipher).
 *        c. Encrypt the SKDM bytes via signalProtocol.encrypt(member, skdm).
 *        d. Send a `skdm` WS frame with group_id + ciphertext.
 *     3. Encrypt the plaintext via groupMessaging.encryptForGroup.
 *     4. Send a `message` WS frame with msg_type='group'.
 *
 * # State: bootstrap tracking
 *
 * Per-process Set of "members we've already sent the SKDM to in this
 * group, this process". Cleared on identity rotation. Not persisted —
 * a redundant SKDM is harmless (libsignal's processSenderKeyDistribution
 * is idempotent on the same key bytes), and the worst-case cost is one
 * extra 1:1 Signal envelope per bootstrap round per cold start. Future:
 * back this with a SQLCipher table for cross-restart skip.
 *
 * # distributionId allocation
 *
 * One UUID v4 per (local-sender, group). The caller passes
 * `getOrCreateDistributionId(groupId)` so the persistence policy lives
 * outside this helper (a tiny Zustand store + AsyncStorage today; moves
 * to SQLCipher when conversation persistence lands).
 */
export interface GroupOrchestratorDeps {
  api: ApiClient;
  signalProtocol: SignalProtocolModule;
  groupMessaging: GroupMessagingModule;
  ws: SpeakeasyWsClient;
  /** Returns a fresh deviceToken (caching delegated to the Vouchflow client). */
  getDeviceToken: () => Promise<string>;
  /** Caller-provided per-group distributionId allocator. */
  getOrCreateDistributionId: (groupId: string) => string;
}

export interface SendGroupMessageOpts {
  groupId: string;
  /** All current members. Sender will be filtered out. */
  members: string[];
  /** Caller's own user id, so we can skip self in the fan-out. */
  selfUserId: string;
  /** UTF-8 bytes of the message body. */
  plaintext: Uint8Array;
}

export interface GroupOrchestrator {
  sendGroupMessage(opts: SendGroupMessageOpts): Promise<void>;
  /** Process an inbound `skdm` WS frame. Decrypt + install the SenderKey. */
  handleIncomingSkdm(frame: {
    from: string;
    group_id: string;
    ciphertext: string;
    message_id: string;
  }): Promise<void>;
  /** Drop bootstrap state — call on identity rotation / sign-out. */
  reset(): void;
}

// utf8ToBytes / bytesToB64 / b64ToBytes imported above from ../utils/bytes.
// They're Hermes-safe (no Buffer dependency).

export function makeGroupOrchestrator(deps: GroupOrchestratorDeps): GroupOrchestrator {
  /** (groupId, recipientUserId) → boolean (sent SKDM in this process). */
  const bootstrapped = new Map<string, Set<string>>();

  function isBootstrapped(groupId: string, peer: string): boolean {
    return bootstrapped.get(groupId)?.has(peer) === true;
  }
  function markBootstrapped(groupId: string, peer: string): void {
    let set = bootstrapped.get(groupId);
    if (!set) {
      set = new Set();
      bootstrapped.set(groupId, set);
    }
    set.add(peer);
  }

  return {
    async sendGroupMessage(opts: SendGroupMessageOpts): Promise<void> {
      const distributionId = deps.getOrCreateDistributionId(opts.groupId);
      const peers = opts.members.filter((m) => m !== opts.selfUserId);
      // Identify peers we still need to bootstrap.
      const newPeers = peers.filter((p) => !isBootstrapped(opts.groupId, p));

      if (newPeers.length > 0) {
        // Mint (or reuse) the SKDM. The native bridge persists per
        // (self, distributionId) state — calling create() twice on the
        // same distributionId is idempotent on the *bytes* libsignal
        // emits when no rotation has happened.
        const skdm = await deps.groupMessaging.createSenderKeyDistribution(distributionId);
        const deviceToken = await deps.getDeviceToken();
        for (const peer of newPeers) {
          // 1:1 session must exist before we can encrypt the SKDM.
          await ensureSessionWithPeer({
            api: deps.api,
            signalProtocol: deps.signalProtocol,
            deviceToken,
            peerUserId: peer,
          });
          const wrapped = await deps.signalProtocol.encrypt(peer, skdm);
          deps.ws.send({
            type: 'skdm',
            to: peer,
            group_id: opts.groupId,
            ciphertext: bytesToB64(wrapped),
          });
          markBootstrapped(opts.groupId, peer);
        }
      }

      // Now the actual group message.
      const ciphertext = await deps.groupMessaging.encryptForGroup(distributionId, opts.plaintext);
      deps.ws.send({
        type: 'message',
        to: opts.groupId,
        ciphertext: bytesToB64(ciphertext),
        msg_type: 'group',
      });
    },

    async handleIncomingSkdm(frame): Promise<void> {
      // Decrypt the 1:1 Signal envelope first → recover raw SKDM bytes.
      const wrapped = b64ToBytes(frame.ciphertext);
      const skdmBytes = await deps.signalProtocol.decrypt(frame.from, wrapped);
      // Install the SenderKey for (sender, distributionId).
      await deps.groupMessaging.processSenderKeyDistribution(frame.from, skdmBytes);
      // Ack so the server deletes the buffered row.
      deps.ws.send({ type: 'ack', message_id: frame.message_id });
    },

    reset(): void {
      bootstrapped.clear();
    },
  };
}

// Re-export for the per-group distributionId zustand store consumers.
export { utf8ToBytes };
