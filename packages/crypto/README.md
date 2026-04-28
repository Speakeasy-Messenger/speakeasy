# @speakeasy/crypto

Signal Protocol wrapper + community channel-key logic.

**Status:** placeholder. Implemented in Phase 2 (see `spec.md` §11).

Two responsibilities:

1. **Signal Protocol (1:1 + small group, E2E)** — exposed as a React Native
   native module. iOS uses CryptoKit (Swift); Android uses Conscrypt /
   BouncyCastle. The official `libsignal-protocol-javascript` was archived
   in Aug 2021, so a native implementation is the correct path and aligns
   with Vouchflow's existing native crypto layer (`spec.md` §4a).

2. **Community channel keys (server-relay, server-side encrypted)** — AES-256
   symmetric key generated on creator device, distributed only to
   Vouchflow-attested members via the gated `/v1/communities/:id/key` endpoint.
   The server never holds the channel key in plaintext (`spec.md` §4b).

Server-side counterpart for Signal Protocol PreKey bundle handling lives in
`@speakeasy/api` and uses `@raphaelvserafim/libsignal`.
