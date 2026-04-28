# @speakeasy/vouchflow

Wrapper around the Vouchflow device-attestation SDK (`vouchflow.dev`).

**Status:** placeholder. Implemented in Phase 1 (see `spec.md` §11).

Vouchflow replaces SMS OTP with Secure Enclave (iOS) / Keystore (Android)
cryptography plus a cross-app device-reputation network. It is the **only**
authentication method in Speakeasy — no email fallback, no SMS, no recovery
codes (`spec.md` §2).

What lands here:

- TypeScript wrapper exposing `attest()`, `currentConfidence()`, `enroll()`
- Hard gate: `confidence < 'medium'` is rejected at enrollment **and** at every
  authenticated request — there is no override
- React Native native-module scaffolding bridging to the underlying Vouchflow
  iOS / Android SDKs

Server-side counterpart is the Vouchflow auth middleware in `@speakeasy/api`
that validates an attestation token on every authenticated request.
