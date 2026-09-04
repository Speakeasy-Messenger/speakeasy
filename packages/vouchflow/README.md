# @speakeasy/vouchflow

Server-side validator + REST client for the Vouchflow device-attestation
service (`vouchflow.dev`).

**Status:** implemented (see `spec.md` §11).

Vouchflow replaces SMS OTP with Secure Enclave (iOS) / Keystore (Android)
cryptography plus a cross-app device-reputation network. It is the **only**
authentication method in Speakeasy — no SMS, no recovery codes (`spec.md`
§2). The single exception is Vouchflow's own email-OTP fallback tier, which
the mobile app can use when its normal device-verification path cannot
complete; it is a client-side SDK flow and does not touch this package. See
`spec.md` §2 for the mobile fallback policy.

What this package provides:

- `Validator` contract and `VouchflowValidator` — `validate(deviceToken)`
  resolves a `ValidatedAttestation` (confidence, risk score, anomaly flags)
  by calling the Vouchflow REST API
- `VouchflowApiClient` — the REST client used by the validator
- `MockValidator` — deterministic responder for tests and local dev
- Confidence policy helpers: `Confidence`, `CONFIDENCE_RANK`,
  `MIN_CONFIDENCE` (`'low'`, matching the vouchflow.dev dashboard floor),
  `meetsMinimumConfidence()`. Raise the floor per-deployment with the
  validator's `minConfidence` option / `VOUCHFLOW_MIN_CONFIDENCE`

Device-side enrollment/attestation (Secure Enclave / Keystore signing) lives
in the mobile app, not here. The `@speakeasy/api` `vouchflowPlugin` /
`requireAuth` preHandler consumes this validator to gate authenticated
requests.
