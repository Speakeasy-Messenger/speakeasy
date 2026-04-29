import type { WsServerMsg, WsClientMsg } from '@speakeasy/shared';

export type WsState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'authed'
  | 'reconnecting'
  | 'closed';

export interface SpeakeasyWsClientOptions {
  url: string;
  /** Called when the client needs a fresh attestation token to authenticate. */
  getToken: () => Promise<string>;
  /** Override WebSocket impl (for tests). Defaults to globalThis.WebSocket. */
  webSocketImpl?: typeof WebSocket;
  /** ms between client→server pings while authed. Default 30s. */
  pingIntervalMs?: number;
  /** Initial reconnect backoff. Default 500ms. */
  reconnectBaseMs?: number;
  /** Cap on backoff. Default 30s. */
  maxReconnectMs?: number;
  /** State change observer. */
  onState?: (state: WsState) => void;
  /**
   * Server frame observer. Single-callback path kept for backwards
   * compatibility with existing wiring; prefer `subscribe()` for new
   * subscribers — the client fans out to every subscribed listener.
   */
  onMessage?: (msg: WsServerMsg) => void;
  /** Now provider — injected for deterministic tests. */
  now?: () => number;
}

type Subscriber = (msg: WsServerMsg) => void;

/** Connection lifecycle: connect → auth → ping loop, with reconnect. */
export class SpeakeasyWsClient {
  private socket?: WebSocket;
  private state: WsState = 'idle';
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private readonly Ws: typeof WebSocket;
  private readonly subscribers = new Set<Subscriber>();
  private readonly stateSubscribers = new Set<(state: WsState) => void>();

  constructor(private readonly opts: SpeakeasyWsClientOptions) {
    const Ws = opts.webSocketImpl ?? (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Ws) throw new Error('No WebSocket implementation available');
    this.Ws = Ws;
  }

  getState(): WsState {
    return this.state;
  }

  connect(): void {
    if (this.state === 'connecting' || this.state === 'authenticating' || this.state === 'authed') {
      return;
    }
    this.intentionalClose = false;
    this.openSocket();
  }

  close(): void {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.socket && this.socket.readyState <= 1) {
      this.socket.close(1000, 'client_close');
    }
    this.setState('closed');
  }

  send(msg: WsClientMsg): void {
    if (this.state !== 'authed' || !this.socket) {
      throw new Error(`cannot send in state=${this.state}`);
    }
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Resolve when the socket reaches `authed`. Useful when the UI lets a
   * user attempt a send right after opening a chat screen — the socket
   * may still be `connecting` / `authenticating` from the App-level
   * mount. Without this, send() throws a generic Error and the UX
   * surfaces an opaque "[send failed]". With this, callers can await
   * the handshake (with a timeout) and surface a clearer "couldn't
   * reach the server" if it never arrives.
   *
   * Rejects on `closed` — the caller must call `connect()` first.
   * Rejects after `timeoutMs` (default 10s) if still not authed.
   */
  waitForAuthed(timeoutMs = 10_000): Promise<void> {
    if (this.state === 'authed') return Promise.resolve();
    if (this.state === 'closed') {
      return Promise.reject(new Error('ws is closed; call connect() first'));
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        unsubscribe();
        reject(new Error(`ws.waitForAuthed timeout after ${timeoutMs}ms (state=${this.state})`));
      }, timeoutMs);
      const unsubscribe = this.onState((state) => {
        if (state === 'authed') {
          clearTimeout(t);
          unsubscribe();
          resolve();
        } else if (state === 'closed') {
          clearTimeout(t);
          unsubscribe();
          reject(new Error('ws transitioned to closed'));
        }
      });
    });
  }

  /**
   * Subscribe to state transitions. Returns an unsubscribe function.
   * Used by `waitForAuthed`.
   */
  private onState(cb: (state: WsState) => void): () => void {
    this.stateSubscribers.add(cb);
    return () => this.stateSubscribers.delete(cb);
  }

  private openSocket(): void {
    this.setState('connecting');
    const ws = new this.Ws(this.opts.url);
    this.socket = ws;

    ws.addEventListener('open', () => {
      void this.handleOpen();
    });
    ws.addEventListener('message', (ev) => {
      this.handleMessage(ev as MessageEvent);
    });
    ws.addEventListener('close', () => {
      this.handleClose();
    });
    ws.addEventListener('error', () => {
      // 'close' will fire after 'error' — handle reconnect there.
    });
  }

  private async handleOpen(): Promise<void> {
    this.setState('authenticating');
    try {
      const token = await this.opts.getToken();
      this.socket?.send(JSON.stringify({ type: 'auth', token }));
    } catch (err) {
      // Bad token / no token: drop the socket; reconnect loop will retry.
      this.socket?.close(4005, 'token_fetch_failed');
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: WsServerMsg;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMsg;
    } catch {
      return;
    }
    if (this.state === 'authenticating' && msg.type === 'authed') {
      this.setState('authed');
      this.reconnectAttempts = 0;
      this.startPingLoop();
    }
    this.opts.onMessage?.(msg);
    for (const sub of this.subscribers) {
      try {
        sub(msg);
      } catch {
        /* one bad subscriber shouldn't take out the others */
      }
    }
  }

  /** Add a frame subscriber. Returns an unsubscribe function. */
  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  private handleClose(): void {
    this.clearTimers();
    this.socket = undefined;
    if (this.intentionalClose) {
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const base = this.opts.reconnectBaseMs ?? 500;
    const max = this.opts.maxReconnectMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private startPingLoop(): void {
    const interval = this.opts.pingIntervalMs ?? 30_000;
    this.pingTimer = setInterval(() => {
      if (this.socket && this.state === 'authed') {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, interval);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private setState(state: WsState): void {
    if (state === this.state) return;
    this.state = state;
    this.opts.onState?.(state);
    for (const sub of this.stateSubscribers) {
      try {
        sub(state);
      } catch {
        /* a misbehaving listener shouldn't break others */
      }
    }
  }
}
