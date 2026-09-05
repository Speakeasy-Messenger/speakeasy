/**
 * Guard against the dated, self-inflicted iOS outage described in
 * `#204` / `352ba1a`: `api.vouchflow.dev` is served with a ~90-day Let's
 * Encrypt leaf, so any build that pins that leaf stops working on rotation
 * day. Both platforms must pin the *issuing intermediates* instead.
 *
 * Two layers, deliberately split:
 *
 *   1. An offline parity check (always runs, including in CI and on a plane):
 *      the pins committed for iOS must be exactly the pins committed for
 *      Android, must be the two intermediates, and must not be a leaf.
 *      Android's pins are the reference because OkHttp has survived a real
 *      rotation with them.
 *   2. A live-chain check against `api.vouchflow.dev` (opt-in, never gates a
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

/** Let's Encrypt issuing intermediates. Both are EC P-384. */
const YE1_PIN = 'brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=';
const YE2_PIN = 's/tdAOmUzd8syaTuqfgGvFcn6DzA5Cmb+Vby1ST+U3Y=';

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

  it('pins both issuing intermediates, so a leaf rotation is survivable', () => {
    for (const pins of [androidPins(), iosPins()]) {
      expect(pins).toContain(YE1_PIN);
      expect(pins).toContain(YE2_PIN);
    }
  });

  it('pins no leaf certificate on either platform', () => {
    for (const source of [android, ios]) {
      for (const leaf of LEAF_PINS_NEVER_TO_PIN) {
        expect(source).not.toContain(leaf);
      }
    }
  });

  it('passes the intermediate constants into both Android SDK pin slots', () => {
    expect(android).toMatch(/leafCertificatePin\s*=\s*VOUCHFLOW_LETS_ENCRYPT_YE2_PIN/);
    expect(android).toMatch(/intermediateCertificatePin\s*=\s*VOUCHFLOW_LETS_ENCRYPT_YE1_PIN/);
  });

  it('passes the intermediate constants into both iOS SDK pin slots', () => {
    // The iOS SDK compares both slots against every certificate in the served
    // chain (OR semantics, no position check), so the slot names are
    // historical — but the values must still both be intermediates.
    expect(ios).toMatch(/leafCertificatePin:\s*letsEncryptYE2Pin/);
    expect(ios).toMatch(/intermediateCertificatePin:\s*letsEncryptYE1Pin/);
  });

  it('keeps the iOS SPM pin at an SDK that validates TLS before pinning', () => {
    // The intermediate pins above are only safe on vouchflow/ios-sdk >= 2.5.0.
    // Up to 2.4.0 the SDK never called SecTrustEvaluateWithError, so a pin
    // match replaced the OS chain/hostname check instead of adding to it. A
    // leaf pin masked that (one key could satisfy it); an intermediate pin
    // does not, because YE1/YE2 appear in every Let's Encrypt chain — on
    // <= 2.4.0 these values would accept any attacker-obtained LE certificate
    // for any hostname. 2.5.0 evaluates trust first, then pins.
    //
    // (< 2.2.0 was separately broken for intermediates: it hardcoded the EC
    // P-256 SPKI header, so a P-384 intermediate pin could never match.)
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
      `iOS SDK is pinned at ${version}, but the committed intermediate pins ` +
        `require >= 2.5.0 (the release that evaluates TLS trust before ` +
        `comparing pins). Downgrading below 2.5.0 while pinning intermediates ` +
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
