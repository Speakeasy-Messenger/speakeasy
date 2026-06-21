import http2 from 'node:http2';
import { createSign } from 'node:crypto';

/**
 * Direct-APNs VoIP push sender (PushKit / CallKit incoming calls).
 *
 * VoIP pushes can't go through FCM — they require a direct APNs HTTP/2
 * connection to the `<bundleId>.voip` topic with `apns-push-type: voip`.
 * Auth is an ES256 JWT signed with the APNs `.p8` auth key (the same key
 * works for both the production and sandbox APNs hosts; the host is chosen
 * by config). The provider JWT is reusable for up to an hour — we cache it
 * for ~50 min and reuse one HTTP/2 session.
 *
 * Reference: Apple "Sending Notification Requests to APNs" + "Responding to
 * VoIP Notifications from PushKit". This is a well-trodden path; the only
 * non-code requirements are the APNs key (a `.p8`) and the topic.
 */

export interface ApnsVoipConfig {
  /** Contents of the APNs auth key `.p8` (PEM, PKCS#8 EC private key). */
  keyP8: string;
  /** The 10-char Key ID of the `.p8`. */
  keyId: string;
  /** The 10-char Apple Team ID. */
  teamId: string;
  /** The app bundle id; the VoIP topic is `<bundleId>.voip`. */
  bundleId: string;
  /** true → api.push.apple.com, false → api.sandbox.push.apple.com. */
  production: boolean;
}

export interface VoipCallPayload {
  /** CallKit call UUID — must match the orchestrator's callId. */
  call_id: string;
  /** Caller handle, e.g. "alice". */
  handle: string;
  /** Display name shown on the CallKit screen. */
  caller_name: string;
  has_video: boolean;
}

export interface VoipSendResult {
  ok: boolean;
  status: number;
  /** APNs reason on failure (e.g. "BadDeviceToken", "Unregistered"). */
  reason?: string;
}

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const TOKEN_TTL_MS = 50 * 60 * 1000; // refresh the JWT well within APNs' 1h cap

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build the ES256 APNs provider JWT. Exported for testing. The signature MUST
 * be raw r‖s ("ieee-p1363"), NOT DER, or APNs rejects it with 403
 * InvalidProviderToken — the single most common APNs-JWT mistake.
 */
export function signApnsProviderJwt(args: {
  keyP8: string;
  keyId: string;
  teamId: string;
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: args.keyId, typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: args.teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  const sig = createSign('SHA256')
    .update(signingInput)
    .sign({ key: args.keyP8, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

export class ApnsVoipSender {
  private readonly host: string;
  private session?: http2.ClientHttp2Session;
  private cachedToken?: { jwt: string; mintedAt: number };

  constructor(private readonly cfg: ApnsVoipConfig) {
    this.host = cfg.production ? PROD_HOST : SANDBOX_HOST;
  }

  /** Build/refresh the ES256 provider JWT. Note: ES256 JWT signatures are
   *  raw r‖s ("ieee-p1363"), NOT DER — getting this wrong yields APNs 403. */
  private providerToken(now = Date.now()): string {
    if (this.cachedToken && now - this.cachedToken.mintedAt < TOKEN_TTL_MS) {
      return this.cachedToken.jwt;
    }
    const jwt = signApnsProviderJwt({
      keyP8: this.cfg.keyP8,
      keyId: this.cfg.keyId,
      teamId: this.cfg.teamId,
      now,
    });
    this.cachedToken = { jwt, mintedAt: now };
    return jwt;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const s = http2.connect(this.host);
    s.on('error', () => {
      /* surfaced per-request; drop the session so the next send reconnects */
      this.session = undefined;
    });
    this.session = s;
    return s;
  }

  /** Send a VoIP push to a single PushKit token. Best-effort; resolves with
   *  the APNs result (never throws on a delivery error). */
  sendVoipPush(deviceVoipToken: string, payload: VoipCallPayload): Promise<VoipSendResult> {
    return new Promise<VoipSendResult>((resolve) => {
      let settled = false;
      const done = (r: VoipSendResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      try {
        const session = this.getSession();
        const body = Buffer.from(JSON.stringify(payload));
        const req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${deviceVoipToken}`,
          authorization: `bearer ${this.providerToken()}`,
          'apns-topic': `${this.cfg.bundleId}.voip`,
          'apns-push-type': 'voip',
          'apns-priority': '10',
          'apns-expiration': '0', // ring now or not at all
          'content-type': 'application/json',
          'content-length': String(body.length),
        });
        let status = 0;
        const chunks: Buffer[] = [];
        req.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('error', (err) => done({ ok: false, status: 0, reason: String(err) }));
        req.on('end', () => {
          if (status === 200) {
            done({ ok: true, status });
            return;
          }
          let reason: string | undefined;
          try {
            reason = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string })
              .reason;
          } catch {
            /* non-JSON body */
          }
          done({ ok: false, status, reason });
        });
        req.setTimeout(10_000, () => {
          req.close();
          done({ ok: false, status: 0, reason: 'timeout' });
        });
        req.end(body);
      } catch (err) {
        done({ ok: false, status: 0, reason: String(err) });
      }
    });
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }
}

/**
 * Build a sender from env, or `undefined` when VoIP push isn't configured
 * (so the call path degrades to the regular FCM/APNs banner push). Env:
 *   APNS_KEY_P8 (PEM, newlines may be \n-escaped), APNS_KEY_ID,
 *   APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRODUCTION (default true).
 */
export function apnsVoipFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsVoipSender | undefined {
  const keyP8 = env.APNS_KEY_P8?.replace(/\\n/g, '\n');
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId } = env;
  if (!keyP8 || !keyId || !teamId || !bundleId) return undefined;
  return new ApnsVoipSender({
    keyP8,
    keyId,
    teamId,
    bundleId,
    production: env.APNS_PRODUCTION !== '0' && env.APNS_PRODUCTION !== 'false',
  });
}
