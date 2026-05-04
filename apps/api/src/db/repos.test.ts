import { describe, expect, it } from 'vitest';
import { InMemoryUserRepo } from './users.memory.js';
import { InMemoryPreKeyRepo } from './prekeys.memory.js';
import { InMemoryGroupRepo } from './groups.memory.js';
import { InMemoryCommunityRepo } from './communities.memory.js';
import { SMALL_GROUP_MAX_MEMBERS } from './groups.js';

function bundle() {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: Buffer.from('spk').toString('base64'),
    signedPreKeySig: Buffer.from('sig').toString('base64'),
    preKeys: [
      { id: 1, key: Buffer.from('k1').toString('base64') },
      { id: 2, key: Buffer.from('k2').toString('base64') },
      { id: 3, key: Buffer.from('k3').toString('base64') },
    ],
  };
}

describe('InMemoryUserRepo.findById', () => {
  it('returns the stored summary', async () => {
    const repo = new InMemoryUserRepo();
    await repo.tryCreate({ userId: 'silent-golden-hawk', deviceToken: 'dvt_silent-golden-hawk', publicKey: Buffer.from('pk'),
      bundle: bundle(),
    });
    const u = await repo.findById('silent-golden-hawk');
    expect(u?.id).toBe('silent-golden-hawk');
    expect(u?.publicKey.equals(Buffer.from('pk'))).toBe(true);
  });

  it('returns undefined for unknown users', async () => {
    expect(await new InMemoryUserRepo().findById('nope-nope-nope')).toBeUndefined();
  });
});

describe('InMemoryPreKeyRepo', () => {
  it('fetchBundleConsume hands out one-time keys then exhausts', async () => {
    const users = new InMemoryUserRepo();
    await users.tryCreate({ userId: 'u', deviceToken: 'dvt_u', publicKey: Buffer.from('pk'), bundle: bundle() });
    const repo = new InMemoryPreKeyRepo(users);

    const b1 = await repo.fetchBundleConsume('u');
    expect(b1?.oneTimePreKey?.id).toBe(1);
    expect(b1?.remainingPreKeys).toBe(2);

    const b2 = await repo.fetchBundleConsume('u');
    expect(b2?.oneTimePreKey?.id).toBe(2);
    expect(b2?.remainingPreKeys).toBe(1);

    await repo.fetchBundleConsume('u');
    const b4 = await repo.fetchBundleConsume('u');
    expect(b4?.oneTimePreKey).toBeNull();
    expect(b4?.remainingPreKeys).toBe(0);
  });

  it('returns undefined for unknown users', async () => {
    const users = new InMemoryUserRepo();
    const repo = new InMemoryPreKeyRepo(users);
    expect(await repo.fetchBundleConsume('ghost')).toBeUndefined();
  });

  it('replenish replaces inventory', async () => {
    const users = new InMemoryUserRepo();
    await users.tryCreate({ userId: 'u', deviceToken: 'dvt_u', publicKey: Buffer.from('pk'), bundle: bundle() });
    const repo = new InMemoryPreKeyRepo(users);
    await repo.replenish({
      userId: 'u',
      signedPreKeyId: 200,
      signedPreKey: 'newspk',
      signedPreKeySig: 'newsig',
      preKeys: [{ id: 99, key: 'newk' }],
    });
    expect(await repo.countRemaining('u')).toBe(1);
    const b = await repo.fetchBundleConsume('u');
    expect(b?.signedPreKeyId).toBe(200);
    expect(b?.oneTimePreKey?.id).toBe(99);
  });

  it('replenish on unknown user throws', async () => {
    const repo = new InMemoryPreKeyRepo(new InMemoryUserRepo());
    await expect(
      repo.replenish({
        userId: 'ghost',
        signedPreKeyId: 1,
        signedPreKey: 'a',
        signedPreKeySig: 'b',
        preKeys: [],
      }),
    ).rejects.toThrow();
  });
});

describe('InMemoryGroupRepo', () => {
  it('creator is auto-member; addMember by non-member rejected', async () => {
    const repo = new InMemoryGroupRepo();
    await repo.create({ groupId: 'grp-1', createdBy: 'a' });
    expect(await repo.isMember('grp-1', 'a')).toBe(true);
    expect(await repo.addMember({ groupId: 'grp-1', userId: 'b', addedBy: 'c' })).toBe(
      'not_member',
    );
    expect(await repo.addMember({ groupId: 'grp-1', userId: 'b', addedBy: 'a' })).toBe(2);
  });

  it('rejects beyond the 100-member ceiling', async () => {
    const repo = new InMemoryGroupRepo();
    await repo.create({ groupId: 'grp-2', createdBy: 'a' });
    for (let i = 1; i < SMALL_GROUP_MAX_MEMBERS; i++) {
      await repo.addMember({ groupId: 'grp-2', userId: `u${i}`, addedBy: 'a' });
    }
    expect(await repo.countMembers('grp-2')).toBe(SMALL_GROUP_MAX_MEMBERS);
    expect(
      await repo.addMember({ groupId: 'grp-2', userId: 'overflow', addedBy: 'a' }),
    ).toBe('group_full');
  });

  it('reports group_missing for unknown groups', async () => {
    const repo = new InMemoryGroupRepo();
    expect(await repo.addMember({ groupId: 'nope', userId: 'b', addedBy: 'a' })).toBe(
      'group_missing',
    );
  });
});

describe('InMemoryCommunityRepo', () => {
  it('creator becomes moderator', async () => {
    const repo = new InMemoryCommunityRepo();
    await repo.create({ communityId: 'com-1', createdBy: 'a' });
    expect(await repo.isMember('com-1', 'a')).toBe(true);
    expect(await repo.isModerator('com-1', 'a')).toBe(true);
  });

  it('addMember requires the adder to be a member', async () => {
    const repo = new InMemoryCommunityRepo();
    await repo.create({ communityId: 'com-1', createdBy: 'a' });
    expect(
      await repo.addMember({ communityId: 'com-1', userId: 'b', addedBy: 'a' }),
    ).toBe('ok');
    expect(
      await repo.addMember({ communityId: 'com-1', userId: 'c', addedBy: 'outsider' }),
    ).toBe('not_member');
  });

  it('envelope store + latest-epoch fetch', async () => {
    const repo = new InMemoryCommunityRepo();
    await repo.create({ communityId: 'com-1', createdBy: 'a' });
    await repo.addMember({ communityId: 'com-1', userId: 'b', addedBy: 'a' });

    await repo.putEnvelope({
      communityId: 'com-1',
      recipientUserId: 'b',
      wrappedKey: Buffer.from('env-v1'),
      wrappedByUserId: 'a',
      keyEpoch: 1,
    });
    expect((await repo.getLatestEnvelope('com-1', 'b'))?.keyEpoch).toBe(1);

    await repo.putEnvelope({
      communityId: 'com-1',
      recipientUserId: 'b',
      wrappedKey: Buffer.from('env-v2'),
      wrappedByUserId: 'a',
      keyEpoch: 2,
    });
    const latest = await repo.getLatestEnvelope('com-1', 'b');
    expect(latest?.keyEpoch).toBe(2);
    expect(latest?.wrappedKey.toString('utf8')).toBe('env-v2');
  });

  it('returns undefined for a recipient with no envelope', async () => {
    const repo = new InMemoryCommunityRepo();
    await repo.create({ communityId: 'com-1', createdBy: 'a' });
    expect(await repo.getLatestEnvelope('com-1', 'b')).toBeUndefined();
  });
});
