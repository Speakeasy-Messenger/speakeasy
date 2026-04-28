import { describe, expect, it } from 'vitest';
import { MockGroupMessagingClient } from './mock-group-messaging.js';
import { GroupMessagingClientError } from './group-messaging.js';

const DIST_ID = 'a3a1b2c3-d4e5-46f7-a890-123456789abc';

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}
function txt(b: Uint8Array): string {
  return Buffer.from(b).toString('utf8');
}

describe('MockGroupMessagingClient', () => {
  it('round-trips a 3-party group via SKDM fan-out', async () => {
    const alice = new MockGroupMessagingClient({ tag: 'alice' });
    const bob = new MockGroupMessagingClient({ tag: 'bob' });
    const carol = new MockGroupMessagingClient({ tag: 'carol' });

    // Alice creates her SenderKey for the group + fans out the SKDM.
    const skdm = await alice.createSenderKeyDistribution(DIST_ID);
    await bob.processSenderKeyDistribution('alice', skdm);
    await carol.processSenderKeyDistribution('alice', skdm);

    // Alice encrypts once; fan-out delivers the same ciphertext to both.
    const ct = await alice.encryptForGroup(DIST_ID, utf8('hello group'));

    expect(txt(await bob.decryptFromGroupMember('alice', ct))).toBe('hello group');
    expect(txt(await carol.decryptFromGroupMember('alice', ct))).toBe('hello group');
  });

  it('throws no_session when a recipient never processed an SKDM', async () => {
    const alice = new MockGroupMessagingClient();
    const bob = new MockGroupMessagingClient();

    const ct = await alice
      .createSenderKeyDistribution(DIST_ID)
      .then(() => alice.encryptForGroup(DIST_ID, utf8('hi')));

    await expect(bob.decryptFromGroupMember('alice', ct)).rejects.toMatchObject({
      message: expect.stringContaining('no SenderKey from alice'),
    });
  });

  it("throws no_session when a sender encrypts before creating their SenderKey", async () => {
    const alice = new MockGroupMessagingClient();
    await expect(alice.encryptForGroup(DIST_ID, utf8('boom'))).rejects.toMatchObject({
      message: expect.stringContaining(`no own SenderKey for ${DIST_ID}`),
    });
  });

  it('multiple senders in the same group all decode each other', async () => {
    // Alice + Bob both author. Carol is a read-only member.
    const alice = new MockGroupMessagingClient();
    const bob = new MockGroupMessagingClient();
    const carol = new MockGroupMessagingClient();

    const aliceSkdm = await alice.createSenderKeyDistribution(DIST_ID);
    const bobSkdm = await bob.createSenderKeyDistribution(DIST_ID);

    // Each member processes every other member's SKDM (typical join flow).
    await bob.processSenderKeyDistribution('alice', aliceSkdm);
    await carol.processSenderKeyDistribution('alice', aliceSkdm);
    await alice.processSenderKeyDistribution('bob', bobSkdm);
    await carol.processSenderKeyDistribution('bob', bobSkdm);

    const aliceCt = await alice.encryptForGroup(DIST_ID, utf8('from alice'));
    const bobCt = await bob.encryptForGroup(DIST_ID, utf8('from bob'));

    expect(txt(await bob.decryptFromGroupMember('alice', aliceCt))).toBe('from alice');
    expect(txt(await carol.decryptFromGroupMember('alice', aliceCt))).toBe('from alice');
    expect(txt(await alice.decryptFromGroupMember('bob', bobCt))).toBe('from bob');
    expect(txt(await carol.decryptFromGroupMember('bob', bobCt))).toBe('from bob');
  });

  it('GroupMessagingClientError shape is what the bridge produces', () => {
    const e = new GroupMessagingClientError('no_session', 'oops');
    expect(e.reason).toBe('no_session');
    expect(e.message).toBe('oops');
    expect(e.name).toBe('GroupMessagingClientError');
  });
});
