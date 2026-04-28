import type { GroupMessagingModule } from './group-messaging.js';

/**
 * Test-only Sender Keys client. Models the libsignal Sender Keys flow at
 * a high level — enough for unit tests of orchestration code (per-group
 * SKDM dispatch, fan-out helpers) without linking the real Rust library.
 *
 * # What it actually does
 *
 * - `createSenderKeyDistribution(distributionId)` returns a deterministic
 *   "SKDM" blob containing the distributionId. This blob can be replayed
 *   to a different mock instance via `processSenderKeyDistribution`,
 *   which mirrors libsignal's per-(sender, group) record into a Map.
 *
 * - `encryptForGroup(distributionId, plaintext)` prepends the
 *   distributionId + senderTag (random per-instance) so the recipient
 *   can demux. The "encryption" is bytewise identity — same security
 *   posture as `MockSignalProtocolClient.encrypt`.
 *
 * - `decryptFromGroupMember(senderUserId, ciphertext)` strips the
 *   header and verifies the recipient has previously processed an SKDM
 *   from `senderUserId` for the embedded distributionId. If not, throws
 *   a 'no_session'-style error matching the production semantics.
 */
const SKDM_MAGIC = 0xa1;
const MSG_MAGIC = 0xa2;

export class MockGroupMessagingClient implements GroupMessagingModule {
  /** Recipient state: distributionId → set of (sender userIds we've processed). */
  private readonly knownSendersByDist = new Map<string, Set<string>>();
  /** Local sender state: distributionId → 1 (we created a key for this group). */
  private readonly ownDistributions = new Set<string>();
  /** Tag to identify which mock instance a ciphertext came from. */
  readonly tag: string;

  constructor(opts: { tag?: string } = {}) {
    this.tag = opts.tag ?? `mock-${Math.random().toString(36).slice(2, 8)}`;
  }

  async createSenderKeyDistribution(distributionId: string): Promise<Uint8Array> {
    this.ownDistributions.add(distributionId);
    return encodeSkdm(distributionId);
  }

  async processSenderKeyDistribution(
    senderUserId: string,
    skdmBytes: Uint8Array,
  ): Promise<void> {
    const distributionId = decodeSkdm(skdmBytes);
    let known = this.knownSendersByDist.get(distributionId);
    if (!known) {
      known = new Set();
      this.knownSendersByDist.set(distributionId, known);
    }
    known.add(senderUserId);
  }

  async encryptForGroup(distributionId: string, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.ownDistributions.has(distributionId)) {
      throw makeError('no_session', `no own SenderKey for ${distributionId}`);
    }
    return encodeMessage(distributionId, plaintext);
  }

  async decryptFromGroupMember(
    senderUserId: string,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    const { distributionId, plaintext } = decodeMessage(ciphertext);
    const known = this.knownSendersByDist.get(distributionId);
    if (!known || !known.has(senderUserId)) {
      throw makeError('no_session', `no SenderKey from ${senderUserId}/${distributionId}`);
    }
    return plaintext;
  }
}

function encodeSkdm(distributionId: string): Uint8Array {
  const idBytes = Buffer.from(distributionId, 'utf8');
  const out = new Uint8Array(2 + idBytes.length);
  out[0] = SKDM_MAGIC;
  out[1] = idBytes.length;
  out.set(idBytes, 2);
  return out;
}

function decodeSkdm(b: Uint8Array): string {
  if (b[0] !== SKDM_MAGIC) throw makeError('invalid_message', 'not an SKDM');
  const len = b[1] ?? 0;
  return Buffer.from(b.slice(2, 2 + len)).toString('utf8');
}

function encodeMessage(distributionId: string, plaintext: Uint8Array): Uint8Array {
  const idBytes = Buffer.from(distributionId, 'utf8');
  const out = new Uint8Array(2 + idBytes.length + plaintext.length);
  out[0] = MSG_MAGIC;
  out[1] = idBytes.length;
  out.set(idBytes, 2);
  out.set(plaintext, 2 + idBytes.length);
  return out;
}

function decodeMessage(b: Uint8Array): { distributionId: string; plaintext: Uint8Array } {
  if (b[0] !== MSG_MAGIC) throw makeError('invalid_message', 'not a group message');
  const len = b[1] ?? 0;
  const distributionId = Buffer.from(b.slice(2, 2 + len)).toString('utf8');
  const plaintext = b.slice(2 + len);
  return { distributionId, plaintext };
}

function makeError(code: string, msg: string): Error {
  const e = new Error(msg) as Error & { code: string };
  e.code = code;
  return e;
}
