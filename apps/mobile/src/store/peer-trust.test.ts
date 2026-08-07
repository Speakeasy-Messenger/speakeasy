import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { usePeerTrust, trustNewIdentity } from './peer-trust.js';
import { noteSessionEstablishedWith } from '../crypto/session.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';

beforeEach(async () => {
  __resetAsyncStorageMock();
  await usePeerTrust.getState().reset();
});

describe('usePeerTrust', () => {
  it('isChanged returns false for unknown peers', () => {
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(false);
  });

  it('markChanged flags the peer and returns true only on the first mark', () => {
    expect(usePeerTrust.getState().markChanged('zzz')).toBe(true);
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(true);
    // Second mark for the same pending change: already flagged.
    expect(usePeerTrust.getState().markChanged('zzz')).toBe(false);
  });

  it('clearChanged removes the flag', () => {
    usePeerTrust.getState().markChanged('zzz');
    usePeerTrust.getState().clearChanged('zzz');
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(false);
  });

  it('hydrate restores flags persisted by markChanged', async () => {
    usePeerTrust.getState().markChanged('zzz');
    // Simulate a fresh process: wipe in-memory state, keep disk.
    usePeerTrust.setState({ changedPeers: {}, hydrated: false });
    await usePeerTrust.getState().hydrate();
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(true);
    expect(usePeerTrust.getState().hydrated).toBe(true);
  });

  it('reset wipes memory and disk', async () => {
    usePeerTrust.getState().markChanged('zzz');
    await usePeerTrust.getState().reset();
    await usePeerTrust.getState().hydrate();
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(false);
  });
});

describe('trustNewIdentity', () => {
  it('resets the native peer state, drops the session cache, and clears the flag', async () => {
    usePeerTrust.getState().markChanged('zzz');
    // Prime the JS session cache so we can observe it being dropped:
    // ensureSessionWithPeer would short-circuit on this entry.
    noteSessionEstablishedWith('zzz');
    const resetPeer = vi.fn().mockResolvedValue(undefined);
    const signalProtocol = { resetPeer } as unknown as SignalProtocolModule;

    await trustNewIdentity(signalProtocol, 'zzz');

    expect(resetPeer).toHaveBeenCalledWith('zzz');
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(false);
  });

  it('leaves the flag set when the native reset throws', async () => {
    usePeerTrust.getState().markChanged('zzz');
    const signalProtocol = {
      resetPeer: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as SignalProtocolModule;

    await expect(trustNewIdentity(signalProtocol, 'zzz')).rejects.toThrow('boom');
    expect(usePeerTrust.getState().isChanged('zzz')).toBe(true);
  });
});
