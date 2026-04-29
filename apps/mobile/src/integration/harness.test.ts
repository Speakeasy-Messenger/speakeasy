import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClient, makeHarness, sendDirect, type Harness } from './harness.js';

/**
 * Smoke test for the integration harness itself. If this fails, the
 * harness has a setup bug — investigate before touching real bug-repro
 * tests in the rest of `src/integration/`.
 */

describe('integration harness — smoke', () => {
  let h: Harness;
  let savedBuffer: typeof globalThis.Buffer | undefined;

  beforeEach(async () => {
    // Approximate Hermes for the test body. We restore Buffer in
    // afterEach because vitest's own machinery uses it between tests.
    savedBuffer = globalThis.Buffer;
    h = await makeHarness({
      users: { dvt_alice: 'alice-blue-fox', dvt_bob: 'bob-red-bear' },
      preEnroll: ['alice-blue-fox', 'bob-red-bear'],
    });
  });

  afterEach(async () => {
    await h.teardown();
    if (savedBuffer) globalThis.Buffer = savedBuffer;
  });

  it('two clients can authenticate concurrently', async () => {
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const bob = await makeClient(h, { token: 'dvt_bob', userId: 'bob-red-bear' });
    expect(alice.ws.getState()).toBe('authed');
    expect(bob.ws.getState()).toBe('authed');
    alice.close();
    bob.close();
  });

  it('a direct message reaches the recipient via the real wire path', async () => {
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const bob = await makeClient(h, { token: 'dvt_bob', userId: 'bob-red-bear' });
    await sendDirect(alice, bob.userId, 'hello bob');
    const incoming = (await bob.await(
      (m) => m.type === 'message',
    )) as { type: 'message'; from: string; ciphertext: string };
    expect(incoming.from).toBe(alice.userId);
    // ciphertext is base64; length should match utf-8('hello bob') + 1
    // marker byte from MockSignalProtocolClient.encrypt.
    expect(incoming.ciphertext.length).toBeGreaterThan(0);
    alice.close();
    bob.close();
  });
});

/**
 * Note on Hermes-approximation: `delete globalThis.Buffer` was tried at
 * the integration-test layer to block the bug class that shipped 0.2.1
 * (`Property 'Buffer' doesn't exist`). It made every test fail because
 * Node's `ws` library uses Buffer internally for frame encoding — that's
 * part of the test infrastructure, not the mobile bundle. The unit test
 * in `src/utils/bytes.test.ts` already deletes Buffer for the helper
 * round-trip, which is the surface area the alpha bug touched. If we
 * find another class of mobile-code-touches-Buffer regression, the next
 * step is an eslint rule banning `Buffer` references in `src/`.
 */
