import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeakeasyWsClient, type WsState } from './client.js';

/**
 * Minimal WebSocket-shaped fake. We control open/message/close events from
 * the test, and capture sends.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  readonly url: string;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly sent: string[] = [];
  private listeners: Record<string, Array<(ev: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(name: string, cb: (ev: any) => void) {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener() {
    /* unused */
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(_code?: number, _reason?: string) {
    this.readyState = this.CLOSED;
    this.fire('close', {});
  }

  fire(name: string, ev: any) {
    for (const cb of this.listeners[name] ?? []) cb(ev);
  }
  open() {
    this.readyState = this.OPEN;
    this.fire('open', {});
  }
  message(payload: unknown) {
    this.fire('message', { data: JSON.stringify(payload) });
  }
}

beforeEach(() => {
  FakeSocket.instances.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeClient(getToken = async () => 'tok-1') {
  const states: WsState[] = [];
  const messages: any[] = [];
  const client = new SpeakeasyWsClient({
    url: 'ws://x/ws',
    getToken,
    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    onState: (s) => states.push(s),
    onMessage: (m) => messages.push(m),
    pingIntervalMs: 1000,
    reconnectBaseMs: 100,
    maxReconnectMs: 1000,
  });
  return { client, states, messages };
}

describe('SpeakeasyWsClient', () => {
  it('connects → authenticates → reaches authed and pings on interval', async () => {
    const { client, states } = makeClient();
    client.connect();
    expect(states).toContain('connecting');

    const sock = FakeSocket.instances[0]!;
    sock.open();
    // getToken is async; let microtasks flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toContain('authenticating');
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: 'auth', token: 'tok-1' });

    sock.message({ type: 'authed', user_id: 'silent-golden-hawk' });
    expect(states).toContain('authed');
    expect(client.getState()).toBe('authed');

    vi.advanceTimersByTime(1000);
    expect(JSON.parse(sock.sent[1]!)).toEqual({ type: 'ping' });
  });

  it('reconnects with exponential backoff on unexpected close', async () => {
    const { client } = makeClient();
    client.connect();
    const first = FakeSocket.instances[0]!;
    first.open();
    await Promise.resolve();
    await Promise.resolve();
    first.message({ type: 'authed', user_id: 'a-b-c' });

    // Drop the connection (simulating network blip).
    first.close();
    expect(client.getState()).toBe('reconnecting');

    // Backoff was base*2^0 = 100ms.
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'auth', token: 'tok-1' });
  });

  it('connect() during reconnecting is a no-op (lets the pending timer fire)', async () => {
    // alpha-0.4.7 reproducer: server's `connections.add` kicked an
    // existing socket whenever the client opened a fresh one mid-
    // reconnect, and the close-event handler scheduled YET ANOTHER
    // reconnect on the orphaned socket. End state was a 1Hz
    // replace-loop visible in the server log. The fix: connect()
    // must not double-up while a reconnect timer is pending.
    const { client } = makeClient();
    client.connect();
    const first = FakeSocket.instances[0]!;
    first.open();
    await Promise.resolve();
    await Promise.resolve();
    first.message({ type: 'authed', user_id: 'me' });
    first.close();
    expect(client.getState()).toBe('reconnecting');

    // External code calls connect() again (e.g. AppState 'active'
    // event). Pre-fix this opened a new socket immediately while the
    // reconnect timer was still pending → two parallel sockets.
    client.connect();
    expect(FakeSocket.instances).toHaveLength(1);

    // The pending reconnect timer fires normally and opens exactly
    // one new socket.
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('a stale socket close is ignored once a newer socket exists', async () => {
    // Defense in depth for the same alpha-0.4.7 issue: even if a
    // stale socket's close fires after `this.socket` already points
    // somewhere else (e.g. server kicked an old one with code 4000
    // 'replaced' and the message arrived after we'd already opened a
    // fresh socket), we must NOT nuke the new socket's state or
    // schedule a reconnect.
    const { client } = makeClient();
    client.connect();
    const first = FakeSocket.instances[0]!;
    first.open();
    await Promise.resolve();
    await Promise.resolve();
    first.message({ type: 'authed', user_id: 'me' });
    first.close();
    vi.advanceTimersByTime(100);

    const second = FakeSocket.instances[1]!;
    second.open();
    await Promise.resolve();
    await Promise.resolve();
    second.message({ type: 'authed', user_id: 'me' });
    expect(client.getState()).toBe('authed');

    // Late close from `first` arrives — the listener should ignore it
    // because `this.socket` no longer points at `first`.
    first.fire('close', {});
    expect(client.getState()).toBe('authed');
  });

  it('does not reconnect after explicit close()', async () => {
    const { client } = makeClient();
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    await Promise.resolve();
    await Promise.resolve();
    sock.message({ type: 'authed', user_id: 'a-b-c' });

    client.close();
    expect(client.getState()).toBe('closed');
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('forwards server messages to onMessage', async () => {
    const { client, messages } = makeClient();
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    await Promise.resolve();
    await Promise.resolve();
    sock.message({ type: 'authed', user_id: 'me' });
    sock.message({
      type: 'message',
      from: 'them',
      message_id: 'mid',
      ciphertext: 'AAA=',
      msg_type: 'direct',
    });
    expect(messages).toHaveLength(2);
    expect(messages[1].type).toBe('message');
    expect(messages[1].from).toBe('them');
  });

  it('refuses send() before authed', () => {
    const { client } = makeClient();
    expect(() =>
      client.send({ type: 'message', to: 'x', ciphertext: 'AAA=', msg_type: 'direct' }),
    ).toThrow();
  });

  it('waitForAuthed resolves once the handshake completes', async () => {
    const { client } = makeClient();
    client.connect();

    let resolved = false;
    const wait = client.waitForAuthed(5000).then(() => (resolved = true));

    const sock = FakeSocket.instances[0]!;
    sock.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    sock.message({ type: 'authed', user_id: 'me' });
    await wait;
    expect(resolved).toBe(true);
  });

  it('waitForAuthed resolves immediately if already authed', async () => {
    const { client } = makeClient();
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    await Promise.resolve();
    await Promise.resolve();
    sock.message({ type: 'authed', user_id: 'me' });
    expect(client.getState()).toBe('authed');
    await client.waitForAuthed(100);
  });

  it('waitForAuthed rejects if the socket transitions to closed', async () => {
    const { client } = makeClient();
    client.connect();
    const wait = client.waitForAuthed(5000);
    client.close();
    await expect(wait).rejects.toThrow(/closed/);
  });

  it('waitForAuthed rejects after the timeout if the handshake never completes', async () => {
    const { client } = makeClient();
    client.connect();
    const wait = client.waitForAuthed(50);
    vi.advanceTimersByTime(60);
    await expect(wait).rejects.toThrow(/timeout/);
  });

  it('enqueueAck queues acks across reconnects and flushes on next authed', async () => {
    const { client } = makeClient();
    client.connect();
    const first = FakeSocket.instances[0]!;
    first.open();
    await Promise.resolve();
    await Promise.resolve();
    first.message({ type: 'authed', user_id: 'me' });

    // Drop the socket *before* the ack goes out. With the old `send`-
    // throws-on-not-authed path the ack was lost; the server kept the
    // row, redelivered, libsignal's ratchet had already advanced, and
    // the user got a stream of `decrypt_failed` bubbles.
    first.close();
    expect(client.getState()).toBe('reconnecting');
    client.enqueueAck('msg-1');
    client.enqueueAck('msg-2');

    vi.advanceTimersByTime(100);
    const second = FakeSocket.instances[1]!;
    second.open();
    await Promise.resolve();
    await Promise.resolve();
    second.message({ type: 'authed', user_id: 'me' });

    const acks = second.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'ack')
      .map((m) => m.message_id);
    expect(acks).toEqual(['msg-1', 'msg-2']);
  });

  it('enqueueAck dedupes while queued (multiple calls before authed → one ack)', async () => {
    const { client } = makeClient();
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    await Promise.resolve();
    await Promise.resolve();
    // Not yet authed — these should coalesce into one queued entry.
    client.enqueueAck('msg-1');
    client.enqueueAck('msg-1');
    client.enqueueAck('msg-1');
    sock.message({ type: 'authed', user_id: 'me' });

    const acks = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'ack');
    expect(acks).toEqual([{ type: 'ack', message_id: 'msg-1' }]);
  });
});
