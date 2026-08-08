import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { republishBundleOnce } from './republish-bundle.js';

beforeEach(() => {
  __resetAsyncStorageMock();
});

describe('republishBundleOnce', () => {
  it('publishes once, then never again on later launches', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);

    await republishBundleOnce(trigger);
    await republishBundleOnce(trigger);
    await republishBundleOnce(trigger);

    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('retries next launch when the publish fails — a failed repair is not "done"', async () => {
    const trigger = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);

    await republishBundleOnce(trigger); // fails, flag must stay unset
    await republishBundleOnce(trigger); // retries, succeeds
    await republishBundleOnce(trigger); // now suppressed

    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('never throws — a failed repair must not break app startup', async () => {
    const trigger = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(republishBundleOnce(trigger)).resolves.toBeUndefined();
  });
});
