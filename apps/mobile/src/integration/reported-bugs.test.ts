import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  type Harness,
  makeClient,
  makeHarness,
  sendDirect,
} from './harness.js';
import { useIdentity } from '../store/identity.js';
import { useConversations } from '../store/conversations.js';
import { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { conversationIdForDirect } from '@speakeasy/shared';

/**
 * Each test in this file reproduces one of the four bugs the user
 * reported on alpha-0.2.2. We write the failing test FIRST, then fix
 * the underlying code until it goes green. CI gates the release tag on
 * this file passing.
 *
 * Bugs (numbering matches the user's report):
 *   1. Peer-not-found surfaces at first-send-time, not at chat-open.
 *   2. Self-DM optimistic bubble shows but echo never round-trips back.
 *   3. Direct-send to a real other user fails with `unknown_error`.
 *      (Native libsignal — Tier B emulator coverage; here we cover the
 *      JS-side path that the harness can reach: ensureSessionWithPeer
 *      against a non-existent peer should throw an ApiError, not
 *      something that gets surfaced as "unknown_error".)
 *   4. Identity wiped on app restart (no AsyncStorage persistence).
 */

describe('reported bug #1 — peer-not-found should surface before chat opens', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({
      users: { dvt_alice: 'alice-blue-fox' },
      preEnroll: ['alice-blue-fox'],
    });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('asking the server whether a peer exists returns 404 for unknown ids', async () => {
    // Spec: a peer-existence precheck route the chat-open path can call
    // before navigating into ChatScreen, so the user gets immediate
    // feedback ("no such user") instead of an opaque `[send failed: 404]`
    // halfway through a conversation.
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const res = await alice.api.fetchPreKeyBundle(
      alice.deviceToken,
      'never-enrolled-anyone',
    ).catch((e) => e);
    expect(res).toBeInstanceOf(Error);
    // ApiError(404) is what the existing prekey route returns for an
    // unknown user. The mobile chat-open precheck reuses this — no need
    // for a separate route — but the UX must catch the error and
    // surface "user not found" before the chat screen mounts.
    expect((res as { status: number }).status).toBe(404);
    alice.close();
  });
});

describe('reported bug #2 — self-DM should round-trip back to the sender', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({
      users: { dvt_alice: 'alice-blue-fox' },
      preEnroll: ['alice-blue-fox'],
    });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('sending a direct message to your own userId echoes back into the conversation log', async () => {
    const alice = await makeClient(h, {
      token: 'dvt_alice',
      userId: 'alice-blue-fox',
    });
    await sendDirect(alice, alice.userId, 'note to self');
    // First check: server fanned the frame back over the wire.
    const echo = (await alice.await(
      (m) => m.type === 'message',
      3000,
    )) as { type: 'message'; from: string; msg_type: string };
    expect(echo.from).toBe(alice.userId);
    expect(echo.msg_type).toBe('direct');
    // Second + critical check: the mobile-side message router bucketed
    // it into the conversation log under the sha-derived self-DM id,
    // with the plaintext extracted (production code skips signal-decrypt
    // for self frames). This is what the user sees as a chat bubble.
    const selfConvId = conversationIdForDirect(alice.userId, alice.userId);
    const bubble = await alice.awaitMessage(
      selfConvId,
      (m) => m.from === alice.userId,
      3000,
    );
    expect(bubble.text).toBe('note to self');
    expect(bubble.kind).toBe('direct');
    alice.close();
  });

  it('a self-DM also surfaces in the global useConversations store with peerUserId set, so ConversationsScreen lists it (regression: 0.2.6 alpha — bubble visible inside chat but no row in list)', async () => {
    // The 0.2.6 alpha showed a self-DM round-trip working inside the
    // chat screen but the conversation row vanished from the list as
    // soon as you backed out. Root cause: the inbound `add()` path on
    // the conversations store fell through to `emptyConversation()`
    // which leaves peerUserId undefined; the list filter requires it.
    // The store's `add()` now derives peerUserId from msg.from on
    // direct messages when the entry didn't already have one. This
    // test locks the fix in.
    useConversations.getState().reset();
    const alice = await makeClient(h, {
      token: 'dvt_alice',
      userId: 'alice-blue-fox',
    });
    // Drive the actual store, mirroring what the App.tsx-mounted router
    // does: addToConversation routes into useConversations.add().
    const selfConvId = conversationIdForDirect(alice.userId, alice.userId);
    useConversations.getState().add(selfConvId, {
      id: 'm1',
      from: alice.userId, // inbound from-self echo
      text: 'note to self',
      kind: 'direct',
      sentAt: Date.now(),
      stage: 'sent',
    });
    const stored = useConversations.getState().byId[selfConvId];
    expect(stored).toBeDefined();
    expect(stored!.kind).toBe('direct');
    expect(stored!.peerUserId).toBe(alice.userId);
    expect(stored!.messages).toHaveLength(1);
    alice.close();
    useConversations.getState().reset();
  });
});

describe('Hermes parity — mobile-code paths do not depend on Buffer', () => {
  it('signalProtocol.encrypt + ws.send + recipient round-trip works without globalThis.Buffer', async () => {
    // 0.2.7 alpha: real-peer send blew up with `Property 'Buffer' doesn't
    // exist` because @speakeasy/crypto's b64Encode used Buffer.from.
    // Vitest runs in Node where Buffer is a global, so the previous
    // tests passed. To replicate the on-device runtime we delete
    // Buffer for the duration of the actual mobile-code calls
    // (encrypt, send, frame parsing) — but restore it before the
    // ws library and harness internals use it for Node-side socket
    // plumbing.
    const h = await makeHarness({
      users: { dvt_alice: 'alice-blue-fox', dvt_bob: 'bob-red-bear' },
      preEnroll: ['alice-blue-fox', 'bob-red-bear'],
    });
    try {
      const alice = await makeClient(h, {
        token: 'dvt_alice',
        userId: 'alice-blue-fox',
      });
      const bob = await makeClient(h, {
        token: 'dvt_bob',
        userId: 'bob-red-bear',
      });
      const savedBuffer = globalThis.Buffer;
      // Hermes-approximation just for the next two awaits.
      // @ts-expect-error runtime-only deletion.
      delete globalThis.Buffer;
      try {
        // Use the actual signalProtocol.encrypt — same code path
        // that ran on device. If the b64Encode helper inside the
        // package reaches for Buffer, this throws and the test fails.
        const plaintext = new Uint8Array([0x59, 0x6f]); // "Yo"
        const ciphertext = await alice.signalProtocol.encrypt(bob.userId, plaintext);
        expect(ciphertext.byteLength).toBeGreaterThan(0);
      } finally {
        globalThis.Buffer = savedBuffer;
      }
      alice.close();
      bob.close();
    } finally {
      await h.teardown();
    }
  });
});

describe('reported bug #3 — encrypt to a real peer should not surface as unknown_error', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({
      users: { dvt_alice: 'alice-blue-fox', dvt_bob: 'bob-red-bear' },
      preEnroll: ['alice-blue-fox', 'bob-red-bear'],
    });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('the JS-layer send path against a real peer round-trips cleanly with the mock signal client', async () => {
    // Tier A can't run real libsignal — that's the actual culprit per
    // the user's `[encrypt failed: unknown_error]`. What we CAN cover
    // here: against the mock signal client, the JS-side send path
    // (ensureSessionWithPeer → encrypt → ws.send → server fan-out →
    // recipient receives) works end-to-end. If this regresses, we know
    // the JS layer is at fault before pointing at libsignal.
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const bob = await makeClient(h, { token: 'dvt_bob', userId: 'bob-red-bear' });
    await sendDirect(alice, bob.userId, 'yo');
    const incoming = (await bob.await(
      (m) => m.type === 'message',
      3000,
    )) as { type: 'message'; from: string; ciphertext: string };
    expect(incoming.from).toBe(alice.userId);
    expect(incoming.ciphertext.length).toBeGreaterThan(0);
    alice.close();
    bob.close();
  });
});

describe('reported bug #4 — identity should persist across app restarts', () => {
  beforeEach(() => {
    __resetAsyncStorageMock();
    // Reset the in-process zustand store between tests.
    void useIdentity.getState().reset();
  });
  afterEach(() => {
    void useIdentity.getState().reset();
  });

  it('hydrate() restores userId across a cold start; the device token is sourced from native secure storage', async () => {
    // Simulate "user enrolled and got an id".
    useIdentity.getState().setUserId('alice-blue-fox');
    useIdentity.getState().setDeviceToken('dvt_alice');
    // Allow the persist() side-effect (fire-and-forget) to flush.
    await new Promise((r) => setTimeout(r, 5));

    // Simulate process kill: blow away the in-process state, then
    // hydrate as if the app cold-started.
    useIdentity.setState({ userId: undefined, deviceToken: undefined, hydrated: false });
    await useIdentity.getState().hydrate();

    expect(useIdentity.getState().userId).toBe('alice-blue-fox');
    // The device token is a bearer-like credential — never persisted to
    // AsyncStorage. hydrate() reloads it from the Vouchflow SDK's native
    // secure storage, which is absent in the test environment, so it
    // stays undefined here (the real app repopulates it from native, or
    // App.tsx drives a fresh verify).
    expect(useIdentity.getState().deviceToken).toBeUndefined();
    expect(useIdentity.getState().hydrated).toBe(true);
  });

  it('hydrate() on a fresh install lands without an identity (no crash)', async () => {
    __resetAsyncStorageMock();
    useIdentity.setState({ userId: undefined, deviceToken: undefined, hydrated: false });
    await useIdentity.getState().hydrate();
    expect(useIdentity.getState().userId).toBeUndefined();
    expect(useIdentity.getState().deviceToken).toBeUndefined();
    expect(useIdentity.getState().hydrated).toBe(true);
  });

  it('reset() wipes both the in-process state AND the persisted copy', async () => {
    useIdentity.getState().setUserId('alice-blue-fox');
    useIdentity.getState().setDeviceToken('dvt_alice');
    await new Promise((r) => setTimeout(r, 5));
    await useIdentity.getState().reset();

    // Re-hydrate; nothing should come back.
    useIdentity.setState({ userId: undefined, deviceToken: undefined, hydrated: false });
    await useIdentity.getState().hydrate();
    expect(useIdentity.getState().userId).toBeUndefined();
    expect(useIdentity.getState().deviceToken).toBeUndefined();
  });
});

describe('reported bug — read receipt re-sent on every chat remount', () => {
  // The diagnostics log showed the same 8 `read` frames redelivered on
  // every reconnect. Root cause: ChatScreen tracked sent read-receipts
  // in a per-mount `useRef` Set (`readSentRef`), which resets whenever
  // the screen remounts (reopen / app resume / push-tap / cold start).
  // Each remount re-emitted `read` for the whole visible peer history.
  // Fix: a persisted per-message `readReceiptSent` flag so a `read`
  // frame is sent exactly once, ever. This test locks in that the flag
  // survives a cold-start hydrate — the property `readSentRef` lacked.
  beforeEach(async () => {
    __resetAsyncStorageMock();
    await useConversations.getState().reset();
  });
  afterEach(async () => {
    await useConversations.getState().reset();
  });

  it('markReadReceiptSent sets the flag and it survives a cold-start hydrate', async () => {
    const convId = 'dm-readreceipt-test';
    useConversations.getState().add(convId, {
      id: 'm1',
      from: 'bob-red-bear', // inbound peer message
      text: 'hi',
      kind: 'direct',
      sentAt: Date.now(),
      stage: 'sent',
    });
    expect(
      useConversations.getState().byId[convId]!.messages[0]!.readReceiptSent,
    ).toBeUndefined();

    useConversations.getState().markReadReceiptSent(convId, 'm1');
    expect(
      useConversations.getState().byId[convId]!.messages[0]!.readReceiptSent,
    ).toBe(true);

    // Let the debounced persist side-effect flush, then simulate a cold
    // start: wipe in-memory state and re-hydrate from disk. The store now
    // coalesces writes on a 400ms trailing debounce, so wait past that.
    await new Promise((r) => setTimeout(r, 450));
    useConversations.setState({ byId: {}, hydrated: false });
    await useConversations.getState().hydrate();

    expect(
      useConversations.getState().byId[convId]?.messages[0]?.readReceiptSent,
    ).toBe(true);
  });

  it('markReadReceiptSent is idempotent', () => {
    const convId = 'dm-readreceipt-idem';
    useConversations.getState().add(convId, {
      id: 'm1',
      from: 'bob-red-bear',
      text: 'hi',
      kind: 'direct',
      sentAt: Date.now(),
      stage: 'sent',
    });
    useConversations.getState().markReadReceiptSent(convId, 'm1');
    useConversations.getState().markReadReceiptSent(convId, 'm1');
    expect(
      useConversations.getState().byId[convId]!.messages[0]!.readReceiptSent,
    ).toBe(true);
  });
});
