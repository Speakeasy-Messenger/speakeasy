/**
 * Guard against the dated, self-inflicted outages described in `#204` /
 * `352ba1a` (leaf pin, 2026-08-10 rotation) and the 2026-09-06 YE1→YE2
 * intermediate rotation: `api.vouchflow.dev` must stay reachable for every
 * already-shipped build across routine CA-side rotations. Both platforms pin
 * the two ISRG **roots** — the anchors of the chains Let's Encrypt serves —
 * not the leaf, and not the issuing intermediates (they rotate a few times a
 * year and buy no security over the root: any certificate the CA issues to
 * anyone carries the same intermediate, so a fraudulently issued certificate
 * for our hostname would pass an intermediate pin exactly as it passes a
 * root pin. Captain's decision 2026-09-06: pin the roots).
 *
 * Three layers, deliberately split:
 *
 *   1. An offline parity check (always runs, including in CI and on a plane):
 *      the pins committed for iOS must be exactly the pins committed for
 *      Android.
 *   2. An offline derivation check (also always runs): the committed pins
 *      must equal the SPKI SHA-256 hashes recomputed from the checked-in
 *      root certificates (`src/integration/fixtures/isrg-root-{x1,x2}.pem`,
 *      fetched from letsencrypt.org, fingerprints cross-checked against the
 *      published values at check-in time). A mistyped or stale hash fails
 *      here instead of in production.
 *   3. A live-chain check against `api.vouchflow.dev` (opt-in, never gates a
 *      PR): set `VOUCHFLOW_LIVE_PIN_CHECK=1`. Run on a schedule by
 *      `.github/workflows/vouchflow-pin-check.yml` so a chain change is
 *      noticed by CI rather than by users in a verification loop.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, type PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');
const androidPath = resolve(
  mobileRoot,
  'android/app/src/main/java/xyz/speakeasyapp/app/MainApplication.kt',
);
const iosPath = resolve(mobileRoot, 'ios/SpeakeasyBridges/Vouchflow/VouchflowBootstrap.swift');
const android = readFileSync(androidPath, 'utf8');
const ios = readFileSync(iosPath, 'utf8');

const fixturesDir = resolve(__dirname, 'fixtures');

/**
 * ISRG Root X2 (EC P-384, expires 2040-09-17): the trust anchor of the chain
 * `api.vouchflow.dev` serves today (leaf → YE2 → Root YE → ISRG Root X2).
 */
const ISRG_ROOT_X2_PEM = readFileSync(resolve(fixturesDir, 'isrg-root-x2.pem'));

/** ISRG Root X1 (RSA 4096, expires 2035-06-04): the RSA-chain anchor. */
const ISRG_ROOT_X1_PEM = readFileSync(resolve(fixturesDir, 'isrg-root-x1.pem'));

/**
 * SPKI SHA-256 of a PEM certificate, base64 — the exact value both SDKs
 * compute on device and the same one the
 * `openssl x509 -pubkey | openssl pkey -pubin -outform der |
 * openssl dgst -sha256 -binary | base64` pipeline produces.
 */
function spkiPin(pem: Buffer): string {
  return createHash('sha256')
    .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
}

/** Pins derived from the checked-in roots — the source of truth, not a copy. */
const ROOT_X2_PIN = spkiPin(ISRG_ROOT_X2_PEM);
const ROOT_X1_PIN = spkiPin(ISRG_ROOT_X1_PEM);

/**
 * Leaf SPKIs that were pinned at some point and must never come back. The
 * `2026-08-10` leaf is the one iOS shipped with until this file changed; it
 * expires 2026-11-08 and Let's Encrypt renews ~30 days ahead of that.
 */
const LEAF_PINS_NEVER_TO_PIN = [
  'mX8Bi7dmXyNH4V/rjrvMcP1ZcxBzrnRmnNPnAvi1kTs=', // leaf valid 2026-08-10 → 2026-11-08
  'NQ7reZqY0tQjef9LBQwbs0gHjrdrroWrd+scM74zQrU=', // leaf that expired in the 2026-08 rotation
];

const SPKI_BASE64 = '[A-Za-z0-9+/]{43}=';

/** Pins declared by `private const val …_PIN = "…"` in MainApplication.kt. */
function androidPins(): string[] {
  return [
    ...android.matchAll(new RegExp(`private const val \\w+ =\\s*"(${SPKI_BASE64})"`, 'g')),
  ].map((m) => m[1]);
}

/** Pins declared by `private static let …Pin = "…"` in VouchflowBootstrap.swift. */
function iosPins(): string[] {
  return [...ios.matchAll(new RegExp(`private static let \\w+ = "(${SPKI_BASE64})"`, 'g'))].map(
    (m) => m[1],
  );
}

describe('Vouchflow certificate pins — committed sources', () => {
  it('commits the same two pins on iOS and Android', () => {
    const a = [...androidPins()].sort();
    const i = [...iosPins()].sort();

    // Sanity: the regexes actually found something. A rename that silently
    // matched nothing would make every other assertion vacuously pass.
    expect(a).toHaveLength(2);
    expect(i).toHaveLength(2);
    expect(i).toEqual(a);
  });

  it('commits exactly the SPKI pins of the checked-in ISRG root fixtures', () => {
    // Recomputed from the certificates themselves, so a typo in either
    // platform's constants (or a stale fixture) fails CI before it fails
    // sign-in for every shipped user.
    expect(ROOT_X2_PIN).toMatch(new RegExp(`^${SPKI_BASE64}$`));
    expect(ROOT_X1_PIN).toMatch(new RegExp(`^${SPKI_BASE64}$`));
    expect(ROOT_X2_PIN).not.toEqual(ROOT_X1_PIN);

    for (const pins of [androidPins(), iosPins()]) {
      expect(pins.sort()).toEqual([ROOT_X1_PIN, ROOT_X2_PIN].sort());
    }
  });

  it('anchors at ISRG Root X2 first (the chain served today) with X1 as fallback', () => {
    // The first slot must be X2 — the trust anchor of the chain
    // api.vouchflow.dev serves right now — and the second X1, the RSA-chain
    // anchor that older trust stores fall back to via the served X2
    // cross-sign. The SDK treats both slots identically (OR semantics), so
    // this is about keeping the two platforms diffing cleanly with a
    // deliberate order, not about SDK behavior.
    expect(android).toMatch(/leafCertificatePin\s*=\s*VOUCHFLOW_ISRG_ROOT_X2_PIN/);
    expect(android).toMatch(/intermediateCertificatePin\s*=\s*VOUCHFLOW_ISRG_ROOT_X1_PIN/);
    expect(ios).toMatch(/leafCertificatePin:\s*isrgRootX2Pin/);
    expect(ios).toMatch(/intermediateCertificatePin:\s*isrgRootX1Pin/);
  });

  it('pins no leaf certificate on either platform', () => {
    for (const source of [android, ios]) {
      for (const leaf of LEAF_PINS_NEVER_TO_PIN) {
        expect(source).not.toContain(leaf);
      }
    }
  });

  it('keeps the iOS SPM pin at an SDK that validates TLS before pinning', () => {
    // The root pins above are only acceptable on vouchflow/ios-sdk >= 2.5.0.
    // Up to 2.4.0 the SDK never called SecTrustEvaluateWithError, so a pin
    // match replaced the OS chain/hostname check instead of adding to it. A
    // leaf pin masked that (one key could satisfy it); a root pin does not:
    // on <= 2.4.0 these values would accept any attacker-obtained
    // certificate that chains to the pinned root — i.e. effectively any
    // Let's Encrypt certificate ever issued, for any hostname. 2.5.0
    // evaluates TLS trust (chain, expiry, revocation, hostname) first, then
    // applies pins as an additional constraint. That validate-first
    // property is exactly what makes root pinning safe.
    //
    // (< 2.2.0 was separately broken for P-384 pins: it hardcoded the EC
    // P-256 SPKI header, so a P-384 pin — ISRG Root X2 — could never match.)
    const pbxproj = readFileSync(
      resolve(mobileRoot, 'ios/Speakeasy.xcodeproj/project.pbxproj'),
      'utf8',
    );
    const version = pbxproj.match(
      /XCRemoteSwiftPackageReference "ios-sdk"[\s\S]*?version = ([\d.]+);/,
    )?.[1];
    expect(version).toBeDefined();
    const [major, minor] = version!.split('.').map(Number);
    expect(
      major > 2 || (major === 2 && minor >= 5),
      `iOS SDK is pinned at ${version}, but the committed root pins ` +
        `require >= 2.5.0 (the release that evaluates TLS trust before ` +
        `comparing pins). Downgrading below 2.5.0 while pinning roots ` +
        `reopens the "any Let's Encrypt certificate is accepted" hole.`,
    ).toBe(true);
  });
});

/**
 * Reads the SPKI SHA-256 pins of every certificate `host` actually serves,
 * leaf first. Same value the `openssl x509 -pubkey | openssl pkey -pubin
 * -outform der | openssl dgst -sha256 -binary | base64` pipeline produces,
 * and the same one both SDKs compute on device.
 */
function servedChainPins(host: string): Promise<string[]> {
  return new Promise((resolvePins, reject) => {
    const socket = connect({ host, port: 443, servername: host }, () => {
      const pins: string[] = [];
      const seen = new Set<string>();
      let cert: PeerCertificate | undefined = socket.getPeerCertificate(true);
      // The root self-signs, so `issuerCertificate` eventually points at
      // itself — stop there rather than looping forever.
      while (cert?.raw && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        const spki = new X509Certificate(cert.raw).publicKey.export({
          type: 'spki',
          format: 'der',
        });
        pins.push(createHash('sha256').update(spki).digest('base64'));
        cert = cert.issuerCertificate;
      }
      socket.end();
      resolvePins(pins);
    });
    socket.setTimeout(15_000, () =>
      socket.destroy(new Error('TLS handshake to api.vouchflow.dev timed out')),
    );
    socket.on('error', reject);
  });
}

// Opt-in: needs network, so it must never be the reason a PR or an offline
// `npm test` fails. `.github/workflows/vouchflow-pin-check.yml` sets the flag.
const live = process.env.VOUCHFLOW_LIVE_PIN_CHECK === '1';

describe.skipIf(!live)('Vouchflow certificate pins — live chain (opt-in)', () => {
  it('serves a chain containing a committed pin, above the leaf', async () => {
    const served = await servedChainPins('api.vouchflow.dev');
    expect(served.length).toBeGreaterThan(1);

    const committed = new Set(iosPins());
    const matches = served.filter((pin) => committed.has(pin));

    // Any match at all means shipped builds still connect today.
    expect(
      matches,
      `No committed pin appears in the live api.vouchflow.dev chain. ` +
        `Committed: ${[...committed].join(', ')}. Served: ${served.join(', ')}. ` +
        `Every shipped iOS and Android build is failing TLS right now.`,
    ).not.toHaveLength(0);

    // A match only at index 0 would mean we are back to pinning the leaf,
    // i.e. the outage is merely rescheduled to the next rotation.
    expect(
      served.slice(1).some((pin) => committed.has(pin)),
      `The only live match is the leaf certificate. The pins have drifted ` +
        `back to leaf pinning and will break at the next rotation. ` +
        `Served: ${served.join(', ')}.`,
    ).toBe(true);
  });
});
