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
});
