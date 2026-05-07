import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/vouchflow.js';

/**
 * ICE server entry as it ships to the mobile client. Mirrors the
 * `RTCIceServer` shape WebRTC consumes directly.
 */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * TURN provider abstraction. Production wiring uses
 * `CloudflareTurnProvider`; local dev uses `StaticTurnProvider` with
 * STUN-only or a hand-rolled coturn config. Swappable so the route
 * doesn't care where credentials come from.
 */
export interface TurnProvider {
  /**
   * Mint a fresh ICE-server config. The userId is bound into the TURN
   * username when supported — useful for per-user bandwidth metering /
   * abuse cutoff. Implementations should issue short-lived credentials
   * (typically 1h) so a leaked token has bounded blast radius.
   */
  issue(opts: { userId: string }): Promise<IceServer[]>;
}

/**
 * STUN-only fallback. Direct-P2P calls work; relayed ones fail to
 * establish. Useful for local dev and as the env-var-not-set default.
 */
export class StaticTurnProvider implements TurnProvider {
  constructor(private readonly servers: IceServer[]) {}
  async issue(): Promise<IceServer[]> {
    return this.servers;
  }
}

/**
 * Cloudflare Calls TURN provider. The `/keys/:keyId/credentials/generate`
 * endpoint returns a fresh username + credential pair scoped to a TTL
 * (in seconds, max 86400 = 24h).
 *
 * Env vars (set on Fly):
 *   CLOUDFLARE_TURN_KEY_ID — the Calls TURN key id
 *   CLOUDFLARE_TURN_TOKEN  — bearer token for the API
 *
 * See:
 *   https://developers.cloudflare.com/calls/turn/
 */
export class CloudflareTurnProvider implements TurnProvider {
  constructor(
    private readonly opts: {
      keyId: string;
      token: string;
      /** TTL in seconds. Cloudflare caps this at 86400 (24h). */
      ttlSeconds?: number;
      /** Override fetch — tests inject a stub. */
      fetchImpl?: typeof fetch;
    },
  ) {}

  async issue(opts: { userId: string }): Promise<IceServer[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const ttl = this.opts.ttlSeconds ?? 3600;
    // `generate-ice-servers` is the current Realtime TURN endpoint;
    // it returns an array containing one STUN entry and one TURN
    // entry with **multiple transports** (udp/3478, tcp/3478,
    // tls/5349, udp/53, tcp/80, tls/443). The TLS-over-443 fallback
    // is what makes mobile-carrier and corporate-firewall calls
    // succeed when udp paths are blocked. The older `generate`
    // endpoint returns a single object with only 4 transports and
    // is being phased out.
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.opts.keyId)}/credentials/generate-ice-servers`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
      },
      // `customIdentifier` is opaque to Cloudflare but shows up on
      // their dashboard's per-credential view — handy when chasing a
      // misbehaving caller. We pass the speakeasy userId.
      body: JSON.stringify({ ttl, customIdentifier: opts.userId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `cloudflare turn credentials: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    const j = (await res.json()) as {
      iceServers: Array<{ urls: string[] | string; username?: string; credential?: string }>;
    };
    return j.iceServers;
  }
}

/**
 * `GET /v1/turn/credentials` — Vouchflow-gated. Returns a fresh ICE
 * server config for a 1:1 voice call. Mobile client calls this right
 * before constructing its `RTCPeerConnection`.
 */
export async function registerTurnRoutes(
  app: FastifyInstance,
  opts: { provider: TurnProvider },
): Promise<void> {
  app.get(
    '/v1/turn/credentials',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      try {
        const ice = await opts.provider.issue({ userId });
        return reply.code(200).send({ ice_servers: ice });
      } catch (err) {
        request.log.warn({ err }, 'turn credentials issue failed');
        return reply.code(503).send({ error: 'turn_unavailable' });
      }
    },
  );
}

/**
 * Build a TurnProvider from environment. Pure dependency wiring —
 * server.ts calls this once at startup. Order:
 *  - CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_TOKEN both set → Cloudflare
 *  - else → STUN-only fallback (Google's public STUN)
 */
export function turnProviderFromEnv(): TurnProvider {
  const cfKey = process.env.CLOUDFLARE_TURN_KEY_ID;
  const cfTok = process.env.CLOUDFLARE_TURN_TOKEN;
  if (cfKey && cfTok) {
    return new CloudflareTurnProvider({ keyId: cfKey, token: cfTok });
  }
  return new StaticTurnProvider([{ urls: 'stun:stun.l.google.com:19302' }]);
}
