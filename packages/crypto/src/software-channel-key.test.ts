import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SoftwareChannelKeyModule } from './software-channel-key.js';

const testSecret = () => new Uint8Array(randomBytes(32));

describe('SoftwareChannelKeyModule', () => {
  it('generates 32-byte channel keys', async () => {
    const m = new SoftwareChannelKeyModule(testSecret());
    const K = await m.generateChannelKey();
    expect(K.length).toBe(32);
    const K2 = await m.generateChannelKey();
    expect(Buffer.from(K).equals(Buffer.from(K2))).toBe(false);
  });

  it('wrap → unwrap round-trips a channel key', async () => {
    const secret = testSecret();
    const wrapper = new SoftwareChannelKeyModule(secret);
    const unwrapper = new SoftwareChannelKeyModule(secret);
    const K = await wrapper.generateChannelKey();
    const env = await wrapper.wrapForRecipient(K, new Uint8Array([1, 2, 3]));
    const recovered = await unwrapper.unwrapForSelf(env);
    expect(Buffer.from(recovered).equals(Buffer.from(K))).toBe(true);
  });

  it('unwrap fails with the wrong recipient secret', async () => {
    const wrapper = new SoftwareChannelKeyModule(testSecret());
    const unwrapper = new SoftwareChannelKeyModule(testSecret());
    const K = await wrapper.generateChannelKey();
    const env = await wrapper.wrapForRecipient(K, new Uint8Array([1, 2, 3]));
    await expect(unwrapper.unwrapForSelf(env)).rejects.toThrow();
  });

  it('encryptMessage → decryptMessage round-trip with the channel key', async () => {
    const m = new SoftwareChannelKeyModule(testSecret());
    const K = await m.generateChannelKey();
    const plaintext = Buffer.from('hello channel');
    const ct = await m.encryptMessage(K, plaintext);
    const pt = await m.decryptMessage(K, ct);
    expect(Buffer.from(pt).toString('utf8')).toBe('hello channel');
  });

  it('decryptMessage fails when ciphertext is tampered', async () => {
    const m = new SoftwareChannelKeyModule(testSecret());
    const K = await m.generateChannelKey();
    const ct = await m.encryptMessage(K, Buffer.from('secret'));
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(m.decryptMessage(K, tampered)).rejects.toThrow();
  });

  it('rejects a non-32-byte test secret', () => {
    expect(() => new SoftwareChannelKeyModule(new Uint8Array(16))).toThrow();
  });
});
