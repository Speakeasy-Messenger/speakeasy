/**
 * In-memory call-signaling buffer for offline recipients.
 *
 * The historical "live-route only" design (see handler.ts call_offer
 * block) dropped any call frame addressed to a recipient with zero
 * live WS connections. In practice that meant: a backgrounded callee
 * whose WS was closed for push routing would receive the FCM push
 * but, when they foregrounded the app and reconnected, the original
 * offer (and the early ICE candidates that trickled after it) had
 * already been discarded server-side. Tapping the push opened the
 * chat, not the call.
 *
 * Fix: buffer the `call_offer` + subsequent `call_ice` frames keyed by
 * recipient userId for a short ringing-window TTL (~30s). On WS
 * authed, drain any pending frames so the mobile orchestrator sees
 * the offer it missed. `call_end` clears the buffer immediately so a
 * caller giving up before the callee reconnects doesn't leave a
 * stale offer waiting to surface.
 *
 * Scope:
 *  - In-memory, single-instance. Multi-instance call signaling would
 *    need a Redis-backed variant, but call signaling already assumes
 *    caller + callee land on the same API instance for the WS
 *    fan-out path; widening that assumption is its own design pass.
 *  - One pending call per recipient at a time. A second offer for the
 *    same recipient replaces the first (the previous caller will time
 *    out and send call_end; no point holding both).
 *  - Multi-device: only buffers when ALL of the recipient's devices
 *    are offline. If at least one device is live, the existing
 *    fan-out reaches that device and the offline ones miss — that's
 *    a multi-device call-routing decision, not a buffering one.
 */

export interface BufferedCallFrame {
  type: 'call_offer' | 'call_ice';
  fromUserId: string;
  callId: string;
  ciphertext: string;
}

export interface CallOfferBuffer {
  /**
   * Record an offer or follow-up ICE frame for a currently-offline
   * recipient. ICE frames are appended only if the matching offer is
   * already buffered (otherwise we'd be holding ICE candidates with
   * no SDP to anchor them to). Fire-and-forget on the Redis variant;
   * a dropped put just means that one frame isn't buffered — the
   * caller's ringing-window timeout produces the same outcome.
   */
  put(toUserId: string, frame: BufferedCallFrame): void;
  /** Clear any pending offer for this recipient + callId pair. */
  clear(toUserId: string, callId: string): void;
  /**
   * Pop and return all pending frames for this recipient (offer
   * first, ICEs in arrival order). Async to accommodate the Redis
   * variant; the in-memory variant resolves immediately.
   */
  drain(toUserId: string): Promise<BufferedCallFrame[]>;
  /** Test seam — current entry count (in-memory only; Redis returns 0). */
  size(): number;
  /** Test seam — clear all timers / local state. */
  shutdown(): void;
}

interface Entry {
  callId: string;
  offer: BufferedCallFrame;
  ices: BufferedCallFrame[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createCallOfferBuffer(opts?: {
  ttlMs?: number;
}): CallOfferBuffer {
  const ttlMs = opts?.ttlMs ?? 30_000;
  const entries = new Map<string, Entry>();

  function evict(toUserId: string): void {
    const e = entries.get(toUserId);
    if (!e) return;
    clearTimeout(e.timer);
    entries.delete(toUserId);
  }

  return {
    put(toUserId, frame) {
      if (frame.type === 'call_offer') {
        // Replace any prior buffered call for this recipient.
        evict(toUserId);
        const timer = setTimeout(() => evict(toUserId), ttlMs);
        // Node's setTimeout returns an object with .unref(); avoid
        // holding the event loop open just to expire stale offers.
        const t = timer as unknown as { unref?: () => void };
        t.unref?.();
        entries.set(toUserId, {
          callId: frame.callId,
          offer: frame,
          ices: [],
          expiresAt: Date.now() + ttlMs,
          timer,
        });
        return;
      }
      // call_ice — append only if it matches the buffered call.
      const e = entries.get(toUserId);
      if (!e || e.callId !== frame.callId) return;
      e.ices.push(frame);
    },
    clear(toUserId, callId) {
      const e = entries.get(toUserId);
      if (!e || e.callId !== callId) return;
      evict(toUserId);
    },
    drain(toUserId) {
      const e = entries.get(toUserId);
      if (!e) return Promise.resolve([]);
      evict(toUserId);
      return Promise.resolve([e.offer, ...e.ices]);
    },
    size() {
      return entries.size;
    },
    shutdown() {
      for (const e of entries.values()) clearTimeout(e.timer);
      entries.clear();
    },
  };
}
