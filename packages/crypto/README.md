# @speakeasy/crypto

Signal Protocol wrapper + community channel-key logic.

**Status:** implemented (see `spec.md` §11). Exposes the native-module
contracts (`signal-protocol.ts`, `channel-key.ts`, `group-messaging.ts`),
a `MockGroupMessagingClient`, and a Node-only `SoftwareChannelKeyModule`
(imported via the `./software-channel-key` subpath — intentionally not in
the package root, since it depends on `node:crypto`, which crashes Metro
bundling in React Native).

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

Server-side PreKey bundle handling lives in `@speakeasy/api` (`db/prekeys.ts`,
`routes/prekeys.ts`). The server performs no Signal cryptography: it stores
opaque key bytes and serves one one-time prekey per fetch ("consume on
fetch"). All Signal session crypto runs on the device via the native module
contracts above.
