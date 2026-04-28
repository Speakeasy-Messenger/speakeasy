import { describe, expect, it } from 'vitest';
import { InMemoryPresence } from './memory.js';

describe('InMemoryPresence', () => {
  it('records online: sets session and presence', async () => {
    const p = new InMemoryPresence();
    await p.recordOnline('alpha-bravo-charlie', 'instance-1');
    expect(await p.lookupInstance('alpha-bravo-charlie')).toBe('instance-1');
    expect(await p.lookupPresence('alpha-bravo-charlie')).toEqual({ state: 'online' });
  });

  it('records offline: drops session, marks last-seen', async () => {
    const p = new InMemoryPresence();
    await p.recordOnline('u', 'i');
    const before = Date.now();
    await p.recordOffline('u');
    expect(await p.lookupInstance('u')).toBeUndefined();
    const pres = await p.lookupPresence('u');
    expect(pres.state).toBe('offline');
    if (pres.state === 'offline') {
      expect(pres.lastSeenMs).toBeGreaterThanOrEqual(before);
    }
  });

  it('returns unknown for unseen users', async () => {
    const p = new InMemoryPresence();
    expect(await p.lookupInstance('ghost')).toBeUndefined();
    expect(await p.lookupPresence('ghost')).toEqual({ state: 'unknown' });
  });
});
