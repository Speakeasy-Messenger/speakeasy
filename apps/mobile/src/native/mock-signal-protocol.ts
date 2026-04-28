import type {
  IdentityKey,
  OwnPreKeyBundle,
  PeerPreKeyBundle,
  SignalProtocolModule,
} from '@speakeasy/crypto';

/**
 * Test-only Signal Protocol client. Returns canned values without touching
 * the native module. Used by mobile unit tests and by `services.ts` when
 * `config.useMockSignalProtocol` is true (e.g. Storybook host or QA build
 * where libsignal isn't linked).
 *
 * `encrypt` / `decrypt` are an identity-with-byte-marker so a mocked
 * round-trip preserves shape without doing any actual crypto: encrypt
 * prepends 0x02 (matches the native bridge's "Whisper" marker), decrypt
 * strips it back off.
 */
export class MockSignalProtocolClient implements SignalProtocolModule {
  private identity: string | undefined;

  constructor(
    private readonly opts: {
      identityPublicKey?: string;
      registrationId?: number;
    } = {},
  ) {}

  async generateIdentityKey(): Promise<IdentityKey> {
    this.identity = this.opts.identityPublicKey ?? 'AAAA';
    return this.identity;
  }

  async generatePreKeyBundle(opts: {
    registrationId: number;
    signedPreKeyId: number;
    oneTimePreKeyCount: number;
  }): Promise<OwnPreKeyBundle> {
    const preKeys = Array.from({ length: opts.oneTimePreKeyCount }, (_, i) => ({
      id: i + 1,
      key: 'AAAA',
    }));
    return {
      identityPublicKey: this.identity ?? this.opts.identityPublicKey ?? 'AAAA',
      registrationId: this.opts.registrationId ?? opts.registrationId,
      signedPreKeyId: opts.signedPreKeyId,
      signedPreKey: 'AAAA',
      signedPreKeySig: 'AAAA',
      preKeys,
    };
  }

  async initiateSession(_peerUserId: string, _peerBundle: PeerPreKeyBundle): Promise<void> {
    // no-op
  }

  async encrypt(_peerUserId: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const out = new Uint8Array(plaintext.length + 1);
    out[0] = 0x02; // SignalMessage marker, matches native bridge
    out.set(plaintext, 1);
    return out;
  }

  async decrypt(_peerUserId: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.length === 0) return ciphertext;
    return ciphertext.slice(1);
  }
}
