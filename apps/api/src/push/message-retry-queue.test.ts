import { describe, expect, it } from 'vitest';
import { createMessageRetryQueue } from './message-retry-queue.js';

describe('createMessageRetryQueue (in-memory)', () => {
  it('claims only entries whose fire time has passed', async () => {
    const q = createMessageRetryQueue();
    q.enqueue('m1', 1000);
    q.enqueue('m2', 2000);
    expect(await q.claimDue(1500, 10)).toEqual(['m1']);
    // m1 already claimed, m2 not yet due.
    expect(await q.claimDue(1500, 10)).toEqual([]);
    expect(await q.claimDue(2000, 10)).toEqual(['m2']);
  });

  it('removes a claimed entry so it is only processed once', async () => {
    const q = createMessageRetryQueue();
    q.enqueue('m1', 100);
    expect(await q.claimDue(200, 10)).toEqual(['m1']);
    expect(await q.claimDue(200, 10)).toEqual([]);
  });

  it('respects the claim limit and returns the rest on the next call', async () => {
    const q = createMessageRetryQueue();
    q.enqueue('m1', 100);
    q.enqueue('m2', 100);
    q.enqueue('m3', 100);
    expect(await q.claimDue(200, 2)).toHaveLength(2);
    expect(await q.claimDue(200, 2)).toHaveLength(1);
    expect(await q.claimDue(200, 2)).toHaveLength(0);
  });

  it('re-enqueue moves the deadline (one entry per id)', async () => {
    const q = createMessageRetryQueue();
    q.enqueue('m1', 100);
    q.enqueue('m1', 5000); // push it later
    expect(await q.claimDue(200, 10)).toEqual([]); // no longer due at t=200
    expect(await q.claimDue(5000, 10)).toEqual(['m1']);
  });
});
