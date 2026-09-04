#!/usr/bin/env node
// Isolate "can Vouchflow deliver a fallback OTP at all" from "is the app
// wired correctly". The onboarding email fallback (#206) has two failure
// modes that look identical on a device — the app never reaching
// `requestFallback`, and Vouchflow accepting the request but never sending
// the code. This talks to the Vouchflow REST API directly, with no app and
// no device, so a run here says which half is at fault.
//
// It stands in for a handset by doing exactly what the SDK's
// EnrollmentManager/VerificationManager do on a device that cannot attest:
// generate a P-256 keypair, enroll without an attestation payload, open a
// verify session, then ask that session for an email fallback. It stops
// there — submitting the OTP needs the code, which is the thing being
// tested for.
//
// Usage:
//   VOUCHFLOW_WRITE_KEY=vsk_... EMAIL=you@example.com \
//     node vouchflow-fallback-probe.mjs
//
// A 200 from the fallback call with no email in the inbox inside the
// 5-minute OTP window means the client is fine and delivery is not.

import crypto from 'node:crypto';

const KEY = process.env.VOUCHFLOW_WRITE_KEY;
const EMAIL = process.env.EMAIL;
const BASE = process.env.VOUCHFLOW_BASE_URL ?? 'https://api.vouchflow.dev';

if (!KEY || !EMAIL) {
  console.error('set VOUCHFLOW_WRITE_KEY and EMAIL');
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      // Pinned by the SDKs; see VouchflowAPIClient.apiVersion.
      'Vouchflow-API-Version': '2026-04-01',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// CryptoKit's `P256.Signing.PublicKey.derRepresentation` is SPKI DER, which
// is what Node's 'spki'/'der' export produces — the same bytes the iOS SDK
// sends as `public_key`.
const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const enroll = await call('POST', '/v1/enroll', {
  idempotency_key: `ik_${crypto.randomUUID().toLowerCase()}`,
  platform: 'ios',
  reason: 'fresh_enrollment',
  // No attestation: this is the un-attestable device the fallback exists for.
  attestation: null,
  public_key: publicKeyB64,
  device_token: null,
});
console.log('enroll', enroll.status, JSON.stringify(enroll.body));
if (enroll.status >= 300) process.exit(1);
const deviceToken = enroll.body.device_token;

// The session is the part that matters: `requestFallback` is keyed to a
// live verify session, so a caller that offers the email fallback WITHOUT
// having opened one gets `no_session` rather than a code.
const verify = await call('POST', '/v1/verify', {
  device_token: deviceToken,
  context: 'signup',
  minimum_confidence: 'low',
});
console.log('verify', verify.status, JSON.stringify(verify.body));
if (verify.status >= 300) process.exit(1);

const emailHash = crypto
  .createHash('sha256')
  .update(EMAIL.trim().toLowerCase())
  .digest('hex');

const fallback = await call('POST', `/v1/verify/${verify.body.session_id}/fallback`, {
  device_token: deviceToken,
  email: EMAIL,
  email_hash: emailHash,
  reason: 'biometric_unavailable',
});
console.log('fallback', fallback.status, JSON.stringify(fallback.body));
if (fallback.status >= 300) process.exit(1);

console.log(
  `\nVouchflow accepted the request. Watch ${EMAIL}: a code must arrive ` +
    `before ${fallback.body.expires_at} or the fallback cannot be completed ` +
    `by anyone, on any device.`,
);
