import { beforeEach, describe, expect, it } from 'vitest';
import { purchaseAvatar } from './purchases.js';
import { useOwnership } from '../store/ownership.js';

/**
 * Regression guard: `purchaseAvatar` MUST NOT grant ownership of a
 * paid SKU it doesn't already own. The prior Phase-A implementation
 * silently flipped ownership after a 700ms delay — that was a real
 * revenue bug (any tap on a rare or legendary tile granted the SKU
 * for free). Locking it down here means a future refactor that
 * reintroduces the same shortcut blows this test up.
 */
describe('purchaseAvatar (Phase B — Play Billing not yet wired)', () => {
  beforeEach(() => {
    useOwnership.setState({ ownedSkus: {} });
  });

  it('refuses to grant ownership of an unowned paid SKU', async () => {
    const outcome = await purchaseAvatar('lynx'); // rare, not owned
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'not_yet_available' });
    // Critical: the side effect — ownership flip — must NOT have happened.
    expect(useOwnership.getState().ownedSkus).toEqual({});
  });

  it('refuses every paid SKU (rare + legendary alike)', async () => {
    for (const id of ['lynx', 'koi', 'raven', 'dragon', 'phoenix']) {
      const outcome = await purchaseAvatar(id);
      expect(outcome.kind, `id=${id}`).toBe('failed');
    }
    expect(useOwnership.getState().ownedSkus).toEqual({});
  });

  it('resolves owned for an already-owned SKU (restore-flow idempotency)', async () => {
    useOwnership.getState().markOwned('com.speakeasy.avatar.rare.lynx');
    const outcome = await purchaseAvatar('lynx');
    expect(outcome.kind).toBe('owned');
    expect(outcome).toMatchObject({ kind: 'owned' });
  });

  it('fails fast for an unknown animal id', async () => {
    const outcome = await purchaseAvatar('not-a-real-avatar');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'no_sku_for_id' });
  });
});
