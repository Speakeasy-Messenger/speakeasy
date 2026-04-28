import { describe, expect, it, vi } from 'vitest';
import { makeReplenisher } from './replenish.js';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import type { ApiClient, PreKeyReplenishRequest, PreKeyReplenishResponse } from '../api/client.js';

interface Captured {
  token: string;
  body: PreKeyReplenishRequest;
}

function makeFakeApi(returnLowWater: boolean[]): {
  api: ApiClient;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const api = {
    async replenishPreKeys(token: string, body: PreKeyReplenishRequest): Promise<PreKeyReplenishResponse> {
      calls.push({ token, body });
      const low = returnLowWater[i++] ?? false;
      return { remaining_prekeys: low ? 5 : 100, low_water: low };
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('makeReplenisher', () => {
  it('mints + uploads a single batch in the happy path', async () => {
    const { api, calls } = makeFakeApi([false]);
    const r = makeReplenisher({
      api,
      signalProtocol: new MockSignalProtocolClient(),
      getDeviceToken: async () => 'dvt_test',
      batchSize: 50,
    });
    await r.trigger();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.token).toBe('dvt_test');
    expect(calls[0]!.body.preKeys).toHaveLength(50);
  });

  it('dedupes concurrent triggers onto a single in-flight round', async () => {
    const { api, calls } = makeFakeApi([false]);
    const r = makeReplenisher({
      api,
      signalProtocol: new MockSignalProtocolClient(),
      getDeviceToken: async () => 'dvt_test',
      batchSize: 10,
    });
    // Six near-simultaneous triggers (typical of a burst of bundle fetches).
    await Promise.all([
      r.trigger(),
      r.trigger(),
      r.trigger(),
      r.trigger(),
      r.trigger(),
      r.trigger(),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('runs one follow-up if server still reports low_water, then stops', async () => {
    const { api, calls } = makeFakeApi([true, true]);
    const log = vi.fn();
    const r = makeReplenisher({
      api,
      signalProtocol: new MockSignalProtocolClient(),
      getDeviceToken: async () => 'dvt_test',
      batchSize: 10,
      log,
    });
    await r.trigger();
    expect(calls).toHaveLength(2);
    // First message: doing follow-up. Second: giving up.
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]![0]).toMatch(/giving up/);
  });

  it('bumps signedPreKeyId monotonically across rounds', async () => {
    const { api, calls } = makeFakeApi([true, false]);
    const r = makeReplenisher({
      api,
      signalProtocol: new MockSignalProtocolClient(),
      getDeviceToken: async () => 'dvt_test',
      batchSize: 5,
      initialSignedPreKeyId: 7,
    });
    await r.trigger();
    expect(calls.map((c) => c.body.signedPreKeyId)).toEqual([7, 8]);
  });

  it('catches replenish errors so callers don\'t see unhandled rejections', async () => {
    const api = {
      async replenishPreKeys(): Promise<PreKeyReplenishResponse> {
        throw new Error('boom');
      },
    } as unknown as ApiClient;
    const log = vi.fn();
    const r = makeReplenisher({
      api,
      signalProtocol: new MockSignalProtocolClient(),
      getDeviceToken: async () => 'dvt_test',
      log,
    });
    await expect(r.trigger()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('prekey replenish failed', { err: 'Error: boom' });
  });
});
