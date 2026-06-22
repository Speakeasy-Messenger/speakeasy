/**
 * Persist-debounce coverage for the conversations store.
 *
 * Root cause of the "messages trickle in ~500ms apart" lag on chat-open:
 * the store called `persist(get().byId)` on every mutation, and each persist
 * JSON.stringify'd the whole store + wrote SQLCipher on the JS thread. A
 * drained backlog of buffered messages = one full-store serialize per
 * message, blocking a render each. The fix coalesces rapid mutations into a
 * single trailing-debounced encrypted write, with an immediate-flush escape
 * hatch for the AppState→background transition.
 *
 * We mock `secure-kv.js` so `secureKv.set` is a spy and assert it is NOT
 * called synchronously across a burst of `add(...)`s, fires exactly once
 * after the debounce window, and fires immediately on flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above module imports, so the spy it references must be
// created inside `vi.hoisted` (which runs first) rather than as a plain const.
const { setSpy } = vi.hoisted(() => ({
  setSpy: vi.fn(async (_key: string, _value: string) => {}),
}));

vi.mock('../native/secure-kv.js', () => ({
  secureKv: {
    get: vi.fn(async () => null),
    set: setSpy,
    delete: vi.fn(async () => {}),
  },
}));

import {
  useConversations,
  flushConversationsPersist,
  type ChatMessage,
} from './conversations.js';

const CONV = 'dm-0123456789abcdef';

const msg = (id: string): ChatMessage => ({
  id,
  from: 'silent-golden-hawk',
  // Distinct text per id so the inbound content-dedup guard doesn't collapse
  // these into one (same sender + text + window).
  text: `hi ${id}`,
  kind: 'direct',
  sentAt: 1_000 + Number(id.slice(1)),
  stage: 'sent',
});

describe('conversations persist debounce', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    setSpy.mockClear();
    // reset() awaits secureKv.delete (mocked) and clears in-memory state.
    await useConversations.getState().reset();
    setSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('coalesces a burst of mutations into exactly one write after the debounce window', () => {
    const { add } = useConversations.getState();
    for (let i = 0; i < 5; i++) add(CONV, msg(`m${i}`));

    // The backlog drained synchronously — but no encrypted write has fired.
    expect(setSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);

    expect(setSpy).toHaveBeenCalledTimes(1);
    // It persisted the latest snapshot (all 5 messages present).
    const [, payload] = setSpy.mock.calls[0]!;
    const parsed = JSON.parse(payload) as Record<
      string,
      { messages: ChatMessage[] }
    >;
    expect(parsed[CONV]?.messages).toHaveLength(5);
  });

  it('does not write before the window elapses', () => {
    useConversations.getState().add(CONV, msg('m0'));
    vi.advanceTimersByTime(399);
    expect(setSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('flushConversationsPersist writes immediately without advancing timers', async () => {
    useConversations.getState().add(CONV, msg('m0'));
    expect(setSpy).not.toHaveBeenCalled();

    await flushConversationsPersist();

    expect(setSpy).toHaveBeenCalledTimes(1);

    // The armed debounce timer was cancelled by the flush, so letting the
    // window elapse must NOT produce a second write.
    vi.advanceTimersByTime(400);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
