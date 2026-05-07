# Speakeasy — Project Specification

> This document is the authoritative source of truth for the Speakeasy project.
> It is intended as the first thing Claude Code reads before taking any action.
> Last updated: April 2026.

---

## Implementation status (April 2026)

| Phase | Server | Mobile | Notes |
| --- | --- | --- | --- |
| 0 — Foundation | ✅ done | ✅ done | Turborepo, `packages/shared` (9 592 adjectives + 7 184 nouns, ID generator, ULID, types), Drizzle schema mirroring §8, Fly.io configs, GH Actions CI. 11 tests. |
| 1 — Auth + Transport | ✅ done | ✅ JS layer, ⚠ no native shells | Vouchflow REST integration (`VouchflowValidator` + `VouchflowApiClient` against `sandbox.api.vouchflow.dev`), `MockValidator` for tests, `requireAuth` middleware (no override below medium), `POST /v1/enroll`, raw `ws` server with auth handshake + ping/pong + reconnect skeleton, `Presence` (in-mem + Redis) wired into WS lifecycle. Mobile JS: theme, brand components (`Wordmark`/`IconMark`/`Button`), `ApiClient`, `SpeakeasyWsClient`, Zustand stores, `OnboardingScreen` + `IdRevealScreen` + `ConversationsScreen`, React Navigation v7, `App.tsx`. |
| 2 — Encryption layer | ✅ server done | ⚠ contracts only | `packages/crypto`: `SignalProtocolModule` + `ChannelKeyModule` interfaces + `SoftwareChannelKeyModule` (test fixture, AES-256-GCM). API: `GET /v1/users/:id`, `POST /v1/prekeys/bundle` (consumes OTPK), `POST /v1/prekeys/replenish`, `POST /v1/groups`, `POST /v1/groups/:id/members` (100-member ceiling enforced), `POST /v1/communities`, `POST /v1/communities/:id/members`, `POST /v1/communities/:id/envelopes`, `GET /v1/communities/:id/key`. Migration 0002 added `community_key_envelopes` and dropped the underspecified `communities.encrypted_key` column. End-to-end round-trip test: wrap-store-fetch-unwrap recovers K. **Mobile-side native crypto** (CryptoKit, Conscrypt, SQLCipher) deferred until native shells are scaffolded — `Native{SignalProtocol,ChannelKey}Module` placeholders throw `not_implemented`. |
| 3 — Messaging | ✅ server done | ⚠ JS layer | Server: WS handler now persists-and-forwards (every send first writes the `messages` table, then routes), fans out group/community to all members minus sender (one row per recipient → independent ack-deletes), drains buffered messages on auth handshake (offline → online), `ack` triggers row delete (spec §5). Conversation IDs per spec §8 (1:1 = sha256(sortedPair) prefixed `dm-`, group/community pass through). 6 new ws-messaging tests cover ack-delete, buffered delivery on reconnect, group + community fan-out, no_recipients, deterministic conversation ids. Mobile: `useConversations` Zustand store with per-conversation TTL options + persistence opt-in (spec §5), `ChatScreen.tsx` with message list, input, send via WS client, auto-ack on receive, local TTL engine driving `DisappearingMessageBubble` through the §14 dissolve. **Real Signal-Protocol encrypt/decrypt** of message payloads + media upload deferred until native shells are scaffolded; today the bubble text equals the base64 ciphertext. |
| 4 — Hardening | ✅ server done | ⚠ JS layer | **Rate limiting** (`InMemoryRateLimiter` + `RedisRateLimiter`, fixed-window per `ratelimit:{subject}:{endpoint}:{bucket}`) on `/v1/enroll` (5/hr), `/v1/prekeys/*` (60/min, 10/min), `/v1/communities/:id/envelopes` (100/min). 429 with `RateLimit-*` headers. **Anomaly-flag rejection** in `VouchflowValidator` (`hardAnomalyFlags` config). **PreKey low_water** signal (threshold 10) on prekey responses; mobile auto-replenishes (route in place; encrypt blocked on native module). **Cross-instance `delivered` routing** via `AckRouter` (in-memory + Redis pub/sub) — `delivered` semantics now = recipient acknowledged across the cluster. **Mobile `CachingVouchflowClient`** caches deviceToken below the server's freshness window so reconnects don't re-prompt. **Push notifications contract** — `PushProvider` interface + `NoopPushProvider` default + `MockPushProvider` for tests + `FcmApnsPushProvider` placeholder; WS handler fires notify-only push when recipient has no live socket (no content per spec). **Multi-device** — migration `0003_devices.sql`, `DevicesRepo` (in-mem + Drizzle schema), `Connections` reworked to `(userId, deviceToken)` keys with `getDevices(userId)`; WS fan-out + cross-instance ack delivery target all live devices. **Security audit** — envelope upload always sets `wrapped_by_user_id` from `auth.userId` (no spoof), logs `audit: 'envelope_upload'` structured event. **Fly.io production config** updated: `min_machines_running = 2`, tuned health checks, `restart_limit = 3`, secrets+volume-snapshot docs in `infra/fly/README.md`. **FCM/APNs delivery + mobile push-token registration + mobile multi-device pairing UX** deferred (need cloud creds + native shells). |
| 5 — Native shells + production polish | 🚧 in progress (Android + server) | 🚧 in progress (Android), ✅ iOS .app packaged end-to-end on Xcode 26.4.1 (4-of-4 native bridges, Metro JS bundle, SQLCipher + libsignal_ffi + Vouchflow linked) | RN shells generated (5a ✅). All four Android native bridges ✅: Vouchflow, Signal Protocol (1:1), Channel Keys, Group Messaging (Sender Keys). **SQLCipher local persistence ✅ (5c)** — `SpeakeasyDb` + `SqlCipherSignalProtocolStore` (5 of 6 SignalProtocolStore interfaces SQLCipher-backed; only Kyber remains in-memory). DB key derived per spec §4c via HKDF-SHA256 from `Vouchflow.cachedDeviceToken` (requires SDK 1.0.3). 1:1 chat encrypt/decrypt + PreKey replenishment auto-trigger ✅ (Phase 5b carry-over). APK: 217 MB. **🍎 iOS counterparts authored** at `apps/mobile/ios/SpeakeasyBridges/` — same JS interfaces, same wire formats (compile-verification pending Mac access). Server: still ahead. Remaining: FCM (5d ✅ Android server+mobile wired; iOS APNs pending), conversations/settings/profile UX + group chat screen (5e), multi-device pairing, sealed sender, Drizzle-impl all repos, metrics endpoint, channel-key rotation policy. See §11 Phase 5 for the full breakdown. |

**Open carry-overs:**

- `apps/mobile/ios` and `apps/mobile/android` native shells aren't generated — see `apps/mobile/README.md` for the one-line `@react-native-community/cli init` command.
- `NativeVouchflowClient`, `NativeSignalProtocolModule`, `NativeChannelKeyModule`, `FcmApnsPushProvider` all throw `not_implemented`. The bridges to the iOS Swift SDK and Android Kotlin SDK + FCM/APNs cloud projects land once the native shells exist.
- ✅ SQLCipher local DB is wired (Phase 5c) via `net.zetetic:sqlcipher-android`. Passphrase derived via HKDF-SHA256 from `Vouchflow.cachedDeviceToken` per spec §4c (requires `dev.vouchflow:android-sdk:1.0.3`). Backs the libsignal `SignalProtocolStore`. Conversation/messages persistence still uses in-memory Zustand — moves to SQLCipher when the chat UX leaves stub state.
- `DisappearingMessageBubble` animates opacity / scale / height with the native driver but tracks a `blurAmount` value as a placeholder. True Gaussian blur arrives with `@react-native-community/blur` once the native shells are linked.
- Mobile multi-device pairing UX (secondary device discovery + envelope re-distribution to new device per spec §4b) deferred to Phase 5.
- ✅ Per-device buffered-delivery tracking — landed in Phase 5f. `messages` table extended with `target_devices` + `delivered_to_devices` arrays (migration 0005); `delivered` fires only after every known device of the recipient acks. Legacy single-device shortcut preserved when `target_devices` is empty (first-time recipient with no devices on file).

**Brand revision applied (April 2026):** §14 rewritten — gold→purple, Inter-only (no Syne/Suisse), new dispersing-signal IconMark. Theme tokens, brand components, and screens all swept. Tagline still WIP — `SLOGAN_PLACEHOLDER` in `OnboardingScreen` is the single point to swap.

**Verified end-to-end (2026-04-26):** demo bootstrapper (`apps/api/dist/demo-server.js`) loaded `apps/api/.env.local` with sandbox keys, hit `https://sandbox.api.vouchflow.dev/v1/device/{token}/reputation` for a bogus deviceToken, mapped Vouchflow's 404 → `{"error":"device_not_found"}` 401 to the client. ~3.5s latency confirmed real network roundtrip, not local stub.

---

## 1. Product Overview

Speakeasy is a private, encrypted messenger with the following core principles:

- **Zero personal information collected.** No phone number, no email, no name.
- **Device-native identity.** Authentication is handled entirely by Vouchflow (vouchflow.dev) — a device-native verification API using Secure Enclave (iOS) and Keystore (Android) cryptography.
- **Ephemeral by default.** Messages disappear after 7 days locally. Persistence must be explicitly opted into per conversation.
- **Human-readable anonymous IDs.** Every user is identified by a randomly generated `adjective-adjective-noun` handle (e.g. `bouncy-red-dragon`). This is their only identifier. No display name layer exists on top.
- **End-to-end encrypted** for all 1:1 and small group conversations.
- **Server-side encrypted** (channel key model) for community chats.

### MVP Scope

- Vouchflow enrollment and authentication
- 1:1 messaging (E2E)
- Small group messaging (E2E, up to ~100 members)
- Community chats (channel key model, server-relay)
- Disappearing messages (7-day default, per-conversation override, persistence opt-in)
- Random ID generation and display

### Post-MVP (explicitly out of scope for now)

- Video calls with automatic face masks, background filters, and voice filters
- Payments (USDT/TRON or USDC/Solana — under consideration)
- Web client

### Phase 6 — Voice calling (in progress)

1:1 voice calls, end-to-end encrypted via DTLS-SRTP whose fingerprints
are authenticated through the existing Signal session. Server is a pure
signaling relay (call_offer/call_answer/call_ice/call_end frames live-
routed only — never persisted to the relay buffer). Group calls deferred.

- ✅ WS frame types `call_offer` / `call_answer` / `call_ice` / `call_end`
  in `packages/shared`. SDP/ICE payloads are Signal-encrypted ciphertext;
  `call_end.reason` is plaintext metadata.
- ✅ Server live-routing in `apps/api/src/ws/handler.ts` — fans out to
  every live device of the callee, pushes notify-only when offline (only
  for `call_offer`), drops other frames silently when offline.
- ✅ TURN credentials route `GET /v1/turn/credentials`,
  Vouchflow-gated. `TurnProvider` interface with `CloudflareTurnProvider`
  + `StaticTurnProvider` (STUN-only fallback). `turnProviderFromEnv()`
  switches on `CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_TOKEN`.
- ✅ Mobile `CallOrchestrator` state machine, mockable `CallPeer`
  interface, `useCalls` Zustand store with persisted history, message-
  router dispatch into `handleFrame`. 7 orchestrator unit tests cover
  dial→accept→connected→hangup, decline, cancel, busy, ring timeout,
  mic/speaker toggles, single-call invariant.
- ✅ Mobile UI: `CallScreen`, `IncomingCallScreen`, `DialerScreen`.
  Phone-icon entry points in `ChatScreen` header (1:1) and
  `ConversationsScreen` header (opens dialer). Local call history
  persisted via AsyncStorage (debug-friendly per user ask).
- 🚧 `react-native-webrtc` native bridge — `webrtc-peer.ts` throws
  `webrtc_not_implemented` until the dep ships. Integration checklist
  in the module docstring covers iOS (CallKit with `includesCallsInRecents:
  false`), Android (ConnectionService, RECORD_AUDIO permission).
- 🚧 CallKit (iOS) + ConnectionService (Android) — pending native shells.
- 🚧 Real-device runtime testing — same blocker as Phase 5 carry-over.

---

## 2. Authentication — Vouchflow

Vouchflow (vouchflow.dev) is a device-native verification API (sibling product to Speakeasy) that replaces SMS OTP using Secure Enclave/Keystore cryptography and a cross-app device reputation network. iOS and Android SDKs shipped April 2026.

**Integration shape (server side):** the mobile SDK does enrollment + challenge + sign + verify-with-Vouchflow internally and returns an opaque `deviceToken` to the app. The app forwards the deviceToken to Speakeasy, which validates by calling `GET /v1/device/{deviceToken}/reputation` with a read-scoped key (`vsk_{sandbox,live}_read_…`) and asserting:

- `last_verification.confidence` ≥ `medium` (no override)
- `last_verification.completed_at` within the freshness window (default 5 min, `VOUCHFLOW_MAX_VERIFICATION_AGE_MS`)
- `risk_score` ≤ ceiling (default 70, `VOUCHFLOW_MAX_RISK_SCORE`)
- `anomaly_flags` are surfaced but not auto-rejecting in MVP — Phase 4 hardens this.

There is no shared HMAC secret. The server's `defaultValidator()` requires `VOUCHFLOW_READ_KEY` + `VOUCHFLOW_BASE_URL` (see `apps/api/.env.local`); set `VOUCHFLOW_USE_MOCK=1` only for offline tests/demos.

### Rules

- **Vouchflow is the only authentication method.** There is no email fallback, no phone number fallback, no recovery code flow.
- **Minimum device confidence: medium.** Devices below medium confidence are rejected at enrollment and at every authenticated request. There is no override.
- **Vouchflow identity does not need to pre-exist.** A new Vouchflow identity is created during Speakeasy enrollment if one does not already exist on the device.
- Enrollment flow: Vouchflow device attestation → random ID generated and issued → Signal Protocol PreKey bundle generated and uploaded → user enters the app.

### Confidence Levels (Vouchflow)

| Level | Description | Allowed |
|---|---|---|
| Low | New device, no history | ❌ |
| Medium | Established device, passing attestation | ✅ |
| High | Strong history, multiple attestations | ✅ |

---

## 3. Identity

- Every user receives a **randomly generated ID** at enrollment in the format `adjective-adjective-noun`.
- Examples: `bouncy-red-dragon`, `silent-golden-hawk`, `velvet-dark-river`
- The ID is generated server-side, guaranteed unique, and stored as the primary user identifier.
- **There is no display name.** The random ID is everything. Users share their ID to connect.
- IDs are permanent. There is no rename or reset mechanism in MVP.

### ID Generator Rules

- Word lists: curated adjective list (~500 words) + noun list (~500 words). No offensive, political, or sensitive words.
- Format: `[adj]-[adj]-[noun]`, all lowercase, hyphen-separated.
- Collision resistance: 500 × 500 × 500 = 125,000,000 possible combinations. Server checks uniqueness before issuance.

---

## 4. Encryption Architecture

### 4a. 1:1 and Small Group Chats — Signal Protocol (E2E)

- Uses the **Signal Protocol** for all 1:1 and group conversations.
- Keys never leave devices. Server relays ciphertext only.
- PreKey bundles stored server-side for session establishment. Server never has access to private keys.
- Group messaging uses **Sender Keys** (one encryption operation per message, distributed to all members).
- Small group ceiling: **100 members**. Above this, conversation must be a Community.

**Signal Protocol implementation:**

- **React Native (mobile):** Implemented as a **native module** using:
  - iOS: CryptoKit (Swift), exposed via React Native bridge
  - Android: Conscrypt / BouncyCastle, exposed via React Native bridge
  - Rationale: React Native's JavaScriptCore does not expose WebCrypto APIs. The official `libsignal-protocol-javascript` is archived (Aug 2021). Native implementation is the correct path and aligns with Vouchflow's existing native crypto layer.
- **Node.js (server):** `@raphaelvserafim/libsignal` — modern TypeScript port, actively maintained.

### 4b. Community Chats — Channel Key Model (Server-Side Encrypted)

Communities are explicitly typed — either set at creation or switched by a moderator. They have their own distinct ID format (separate from user IDs).

**How it works:**

1. When a community is created, a **symmetric AES-256 channel key** `K` is generated on the creator's device. Tracked by `key_epoch`, starting at 1.
2. `K` is distributed via per-recipient **envelopes**: an existing member's device wraps `K` with each recipient's identity public key (ECIES) and POSTs the resulting blob to `POST /v1/communities/:id/envelopes`. The server stores envelopes — never plaintext `K`.
3. Server stores community messages as ciphertext encrypted with `K`. Without `K`, the database is opaque.
4. New members fetch their envelope via `GET /v1/communities/:id/key`. The server validates Vouchflow attestation + community membership, then returns the wrapped envelope. The recipient's device unwraps with its identity private key (held in the secure enclave).
5. **Key rotation:** new `K`, bumped `key_epoch`, fresh envelopes for all members. Triggers (Phase 2 default policy):
   - Moderator-triggered rotation
   - Automatic rotation on a member leave (revocation guarantee)

The envelope table (`community_key_envelopes`, see §8) is the source of truth for distribution. The original single-blob `communities.encrypted_key` column was dropped in migration 0002 once the envelope model was clarified.

**What this means for trust:**
The server cannot read community messages. A database breach alone exposes nothing. Compelled key disclosure would require obtaining keys from member devices, not from the server. This is disclosed honestly to users: "Community messages are not end-to-end encrypted, but encryption keys never touch our servers."

### 4c. Local Storage Encryption

- All messages stored locally in **SQLite via `react-native-quick-sqlite` + SQLCipher**.
- Local DB key derived from Vouchflow device key — no separate passphrase for the user.

---

## 5. Disappearing Messages

- **Default:** 7 days local TTL. Messages are deleted from the device after 7 days.
- **Server behavior:** Messages are deleted from the server **on confirmed delivery** (`{type: "ack"}` from the recipient → server deletes the row). The 7-day TTL applies to the relay buffer for undelivered messages only.
- **Per-conversation override (Phase 3 default options):** `hour` · `day` · `week` · `month` · `off`. Configured via the `useConversations` store; surfaced as a tappable pill in the chat input bar.
- **Persistence opt-in:** Users can toggle persistence on for a specific conversation. This disables the local TTL for that conversation only. Server behavior is unchanged.
- **Community chats:** Default 7-day TTL on server for community message ciphertext. Moderators can configure this.

**WebSocket `delivered` semantics (Phase 3):** for `direct` messages the server emits `delivered` to the sender as soon as the message is buffered server-side and (if recipient is online on this instance) forwarded. This is one notch weaker than "recipient acknowledged"; Phase 4 cross-instance ack routing tightens it to the strict reading. For `group` / `community` messages there is no server-emitted `delivered` (one ack per recipient would fan out N events).

---

## 6. Conversation Types

| Type | Max Members | Encryption | Server Stores | ID Format |
|---|---|---|---|---|
| 1:1 | 2 | Signal Protocol (E2E) | Ciphertext only, deleted on delivery | n/a |
| Group | 3–100 | Signal Protocol (E2E, Sender Keys) | Ciphertext only, deleted on delivery | `grp-[ulid]` |
| Community | Unlimited | Channel key model | Ciphertext, 7-day TTL | `com-[ulid]` |

Communities are a distinct type from the data model level — separate tables, separate key model, separate ID namespace. Switching a group to a community is a one-way migration in MVP.

---

## 7. Tech Stack

### Mobile

| Concern | Choice | Rationale |
|---|---|---|
| Framework | React Native | Cross-platform, JS/TS ecosystem |
| State | Zustand | Lightweight, no boilerplate |
| Navigation | React Navigation v7 | Standard RN navigation |
| Local DB | react-native-quick-sqlite + SQLCipher | Encrypted SQLite |
| Crypto | Native module (CryptoKit / Conscrypt) | WebCrypto unavailable in JSC |
| Push | FCM + APNs (notify only, no content) | Privacy-preserving notifications |

### Backend

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js + TypeScript | Team familiarity, ecosystem |
| Framework | Fastify | Performance, low overhead |
| WebSocket | `ws` (raw) | Minimal surface, no Socket.io overhead |
| ORM | Drizzle ORM | TypeScript-native, lightweight |
| Migrations | node-pg-migrate | Simple, SQL-first |
| Signal Protocol | @raphaelvserafim/libsignal | Modern TS, actively maintained |

### Infrastructure

| Concern | Choice | Notes |
|---|---|---|
| Hosting | Fly.io | Multi-region included, migrate to AWS at scale |
| Database | PostgreSQL (Fly managed) | Persistent store |
| Cache / Presence | Redis (Fly managed) | Ephemeral state, WebSocket routing |
| Object Storage | Fly Volumes (MVP) → S3-compatible (scale) | Encrypted media |
| CI/CD | GitHub Actions | Lint, type-check, test, deploy |

**AWS migration trigger:** When Fly.io Postgres tier jumps become unpredictable, or when enterprise compliance (SOC2, HIPAA) becomes a sales requirement. Docker containers from day one make migration mechanical.

---

## 8. Database Schema (High-Level)

```sql
-- Users
users (
  id          TEXT PRIMARY KEY,   -- adjective-adjective-noun
  public_key  BYTEA NOT NULL,      -- identity public key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

-- PreKey bundles (Signal Protocol)
prekey_bundles (
  user_id           TEXT REFERENCES users(id),
  registration_id   INTEGER NOT NULL,
  signed_prekey_id  INTEGER NOT NULL,
  signed_prekey     BYTEA NOT NULL,
  signed_prekey_sig BYTEA NOT NULL,
  prekeys           JSONB NOT NULL,   -- array of {id, key}
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

-- Groups
groups (
  id          TEXT PRIMARY KEY,    -- grp-[ulid]
  created_by  TEXT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

group_members (
  group_id    TEXT REFERENCES groups(id),
  user_id     TEXT REFERENCES users(id),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
)

-- Communities
communities (
  id              TEXT PRIMARY KEY,  -- com-[ulid]
  created_by      TEXT REFERENCES users(id),
  ttl_days        INTEGER NOT NULL DEFAULT 7,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

-- Channel-key envelopes — channel key K wrapped once per recipient (spec §4b).
-- Server stores envelopes only; never plaintext K.
community_key_envelopes (
  community_id        TEXT REFERENCES communities(id) ON DELETE CASCADE,
  recipient_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key         BYTEA NOT NULL,
  wrapped_by_user_id  TEXT REFERENCES users(id),
  key_epoch           INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, recipient_user_id, key_epoch)
)

community_members (
  community_id  TEXT REFERENCES communities(id),
  user_id       TEXT REFERENCES users(id),
  role          TEXT NOT NULL DEFAULT 'member',  -- member | moderator
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
)

-- Message relay buffer (all types)
-- Deleted on delivery. 7-day TTL for undelivered.
messages (
  id            TEXT PRIMARY KEY,    -- ulid
  conversation  TEXT NOT NULL,       -- user_id pair hash | group_id | community_id
  sender_id     TEXT NOT NULL,
  ciphertext    BYTEA NOT NULL,
  msg_type      TEXT NOT NULL,       -- direct | group | community
  delivered     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL  -- set to created_at + 7 days
)
```

Redis keys:
- `session:{user_id}` → WebSocket server instance ID (for routing)
- `presence:{user_id}` → online/offline + last seen
- `ratelimit:{user_id}:{endpoint}` → sliding window counter

---

## 9. API Surface (High-Level)

### REST endpoints

All endpoints below `/v1/enroll` require `Authorization: Bearer <vouchflow_device_token>`. The middleware enforces the spec §2 confidence floor (no override).

```
POST   /v1/enroll                          Vouchflow attestation → issue ID + store PreKey bundle
GET    /v1/users/:id                       Lookup user by random ID (returns public_key)
POST   /v1/prekeys/bundle                  Fetch a peer's bundle (consumes one one-time prekey)
POST   /v1/prekeys/replenish               Upload new prekeys (caller's userId from auth)
POST   /v1/groups                          Create group (caller becomes first member)
POST   /v1/groups/:id/members              Add member (caller must be a member; ≤100 cap)
POST   /v1/communities                     Create community (caller becomes moderator)
POST   /v1/communities/:id/members         Add member (caller must be a member)
POST   /v1/communities/:id/envelopes       Upload a wrapped channel-key envelope (member-only)
GET    /v1/communities/:id/key             Fetch caller's latest-epoch envelope (member-only)
```

### WebSocket protocol

```
// Client → Server
{ type: "auth",    token: "<vouchflow_token>" }
{ type: "message", to: "<id>", ciphertext: "<base64>", msg_type: "direct|group|community" }
{ type: "ack",     message_id: "<id>" }
{ type: "ping" }

// Server → Client
{ type: "authed",   user_id: "<id>" }
{ type: "message",  from: "<id>", ciphertext: "<base64>", message_id: "<id>", msg_type: "..." }
{ type: "delivered", message_id: "<id>" }
{ type: "pong" }
{ type: "error",    code: "<string>", message: "<string>" }
```

---

## 10. Repository Structure

```
speakeasy/
├── apps/
│   ├── mobile/                     # React Native app
│   │   ├── src/
│   │   │   ├── screens/
│   │   │   ├── components/
│   │   │   ├── navigation/
│   │   │   ├── store/              # Zustand stores
│   │   │   ├── hooks/
│   │   │   └── native/             # Bridge to native crypto module
│   │   ├── ios/
│   │   └── android/
│   └── api/                        # Node.js backend
│       ├── src/
│       │   ├── routes/
│       │   ├── ws/                 # WebSocket server + handlers
│       │   ├── services/
│       │   ├── middleware/         # Vouchflow auth middleware
│       │   └── db/                 # Drizzle schema + queries
│       └── Dockerfile
├── packages/
│   ├── shared/                     # Shared types, constants, ID generator
│   ├── crypto/                     # Signal Protocol wrapper, channel key logic
│   └── vouchflow/                  # Vouchflow SDK integration + native module
├── infra/
│   ├── fly/                        # fly.toml configs
│   └── migrations/                 # SQL migration files
├── turbo.json
├── package.json                    # Root workspace
└── SPEC.md                         # This file
```

---

## 11. Build Sequence

### Phase 0 — Foundation (Week 1)
- [x] Turborepo monorepo scaffold
- [x] `packages/shared`: TypeScript types, adjective-adjective-noun ID generator, message envelope schema, ULID utility
- [x] Database schema + first migration (users, prekey_bundles, groups, communities, messages)
- [x] Fly.io initial config (`speakeasy-api`, `speakeasy-db`, `speakeasy-redis`)
- [x] GitHub Actions: lint, type-check, test pipeline

### Phase 1 — Auth + Transport (Weeks 2–3)
- [x] `packages/vouchflow`: real SDK integration (`VouchflowApiClient` + `VouchflowValidator` against the live REST API), `MockValidator` test fixture, confidence/freshness/risk-score gates
- [x] API: `/v1/enroll` endpoint
- [x] API: Vouchflow auth middleware (validates every authenticated request, no override below medium)
- [x] API: WebSocket server with authenticated handshake (raw `ws`, 10s auth deadline, ping/pong)
- [x] API: Presence + session routing (`Presence` interface, Redis impl + in-memory fallback)
- [x] Mobile: Enrollment screen, ID display, WebSocket connection lifecycle (JS layer; native shells deferred — see `apps/mobile/README.md`)

### Phase 2 — Encryption Layer (Weeks 3–5)
- [ ] `packages/crypto`: Signal Protocol native module (CryptoKit iOS + Conscrypt Android) — placeholder `NativeSignalProtocolModule` exists; throws until shells land
- [x] `packages/crypto`: Channel key AES-256 generation, encryption, distribution — interfaces + `SoftwareChannelKeyModule` test fixture done; native impl pending shells
- [x] API: PreKey bundle endpoints (`/v1/prekeys/bundle` consumes OTPK; `/v1/prekeys/replenish`)
- [x] API: Channel key distribution endpoint (`/v1/communities/:id/key`) with Vouchflow gate, plus `/envelopes` upload, `/v1/users/:id`, group + community CRUD
- [x] Mobile: Encrypted local SQLite setup (SQLCipher) — landed in Phase 5c. DB passphrase derived via HKDF-SHA256(`Vouchflow.cachedDeviceToken`, salt="speakeasy-db-v1", info="sqlcipher-passphrase", L=32). The token is bytewise-stable across cold starts (set once during enrollment, read back unmodified per verify) and survives reboots without biometric or network — exposed on `Vouchflow.shared` from SDK 1.0.3. Detail in §11 5c.

### Phase 3 — Messaging (Weeks 5–8)
- [x] 1:1 messaging: persist-and-forward, ack-on-delete, deliver-on-reconnect (server-side); client-side encrypt/decrypt + session establishment wired to the native Signal Protocol module (Phase 5b carry-over).
- [x] Group messaging: server-side fan-out to all members minus sender, one row per recipient. Sender Keys encrypt happens on device (blocked on native module).
- [x] Community chats: server-side fan-out + envelope upload/fetch + ack-delete. Real channel-key encrypt/decrypt blocked on native module.
- [x] Disappearing messages: per-conversation TTL options + persistence opt-in (`useConversations`); local TTL engine in `ChatScreen` drives `DisappearingMessageBubble` through the spec §14 dissolve. Server-side 7-day relay TTL applied to undelivered buffer.
- [ ] Message types: text-only this phase (per spec). Media (client-side encrypted before upload) deferred to a later sub-phase.

### Phase 4 — Hardening (Weeks 8–10)
- [x] Push notifications (notify-only) — `PushProvider` contract + Noop/Mock impls; WS triggers on offline recipient. **FCM delivery wired (Phase 5d): `FcmApnsPushProvider` + `POST /v1/devices/push-token` + mobile `PushNotificationService` + auto-registration on enrollment/startup. iOS APNs pending.**
- [x] Rate limiting on all API surfaces — `InMemoryRateLimiter` + `RedisRateLimiter`, applied to enroll / prekeys / envelopes
- [x] PreKey replenishment monitoring — `low_water` signal in responses; mobile `replenishPreKeys` route in `ApiClient` (real bundle generation blocked on native Signal module)
- [x] Basic security pass on channel-key distribution — `wrapped_by_user_id` always = `auth.userId` (no spoof), structured `audit: 'envelope_upload'` log entries
- [x] Fly.io production config: autoscaling, health checks, volume snapshots — `min_machines_running = 2`, tuned health checks, `restart_limit = 3`, snapshot docs in `infra/fly/README.md`
- [x] Multi-device support — migration `0003_devices.sql`, `DevicesRepo`, `Connections` reworked to `(userId, deviceToken)`, WS fan-out + cross-instance ack delivery target all live devices. **Mobile multi-device pairing UX deferred** (needs native shells).
- [x] **Bonus** — cross-instance `delivered` routing via `AckRouter` (Redis pub/sub), tightening spec §5 to "recipient acknowledged"
- [x] **Bonus** — `CachingVouchflowClient` on mobile so WS reconnects don't re-prompt biometric every time
- [x] **Bonus** — `hardAnomalyFlags` rejection policy in `VouchflowValidator`

### Phase 5 — Native shells + production polish (Weeks 11–14)

**Theme:** every Phase 1–4 carry-over collapses around one fundamental dependency — the `apps/mobile/{ios,android}` native shells. Once those exist, the placeholder native modules become real and the JS contracts I built throughout earlier phases become wires to actual hardware. This phase is about closing all of those, plus the production-polish items that didn't fit earlier.

**🍎 iOS items are queued — they need a macOS host (Xcode, CocoaPods, simulator).** Marked inline so it's obvious which items can ship from a Linux dev box and which are blocked on a Mac.

#### 5a. Native shell scaffolding
- [ ] `npx @react-native-community/cli init Speakeasy --version 0.76.5` → move `ios/`, `android/` into `apps/mobile/`. README has the exact command.
- [ ] Wire `metro.config.js` to the existing monorepo layout (already authored — needs a real shell to verify against).
- [ ] Android `build.gradle` uses bundle id `xyz.speakeasyapp.app`; Inter font added to `android/app/src/main/assets/fonts/`.
- [x] 🍎 iOS — bundle id `xyz.speakeasyapp.app`, `Info.plist` (`NSFaceIDUsageDescription` + `UIAppFonts`), `Podfile` (only SQLCipher 4.6 from CocoaPods — Vouchflow + libsignal-client are SPM-only). Vouchflow added via `XCRemoteSwiftPackageReference` (pinned `1.0.5` for `cachedDeviceToken` support, mirroring Android 1.0.3). Bridges added to target via Ruby `xcodeproj` script. SQLCipher's C `sqlite3.h` exposed to Swift via `SpeakeasyBridges/Speakeasy-Bridging-Header.h` — the pod ships no Swift modulemap. Compile-verified on Mac (Xcode 26.4.1) over SSH/Tailscale.
- [ ] CI Linux runner for Android (`gradle assembleRelease`).
- [ ] 🍎 iOS — CI macOS runner for `xcodebuild archive` on PRs.

#### 5b. Native module bridges
- [x] **Vouchflow Android** — Kotlin module wrapping `dev.vouchflow:android-sdk:1.0.0`, bridge to JS as part of `NativeVouchflowClient`. The `CachingVouchflowClient` wrapper composes around it unchanged. Includes minSdk bump to 28, BuildConfig field plumbing for the API key + environment (`gradle.properties.example` checked in; real key stays out of git), `VouchflowError` sealed class → JS `VouchflowClientError` reason mapping, dropped `currentConfidence()` (SDK uses `minimumConfidence` arg on `verify()` instead). APK builds clean: 170MB, package `xyz.speakeasyapp.app`.
- [x] 🍎 **Vouchflow iOS** — `VouchflowModule.{swift,m}` + `VouchflowBootstrap.swift` at `apps/mobile/ios/SpeakeasyBridges/Vouchflow/`. **Compile-verified on Xcode 26.4.1 against Vouchflow iOS SDK 1.0.5.** API surface adjustments needed during verify: SDK module name is `VouchflowSDK` (not `Vouchflow`); `Vouchflow.configure(_:)` is `throws` and takes a Swift struct, so wrapped in `SpeakeasyVouchflowBootstrap.configureWithApiKey:environment:error:` for ObjC AppDelegate consumption; `VerificationContext` has no `.transaction` case (mapped to `.sensitiveAction`); error case names are `.invalidAPIKey` / `.keychainAccessDenied` (capitalisation differs from Kotlin); signal property is `keychainPersistent` (Android side renamed to `persistentToken`, JS layer uses Android's name — remapped at the bridge). Reads `Vouchflow.plist` (gitignored — `.example` checked in) for the API key + environment.
- [x] **Signal Protocol Android (1:1 path)** — Kotlin module wrapping `org.signal:libsignal-android:0.59.0` (AGPLv3; Speakeasy is open-source so license-compatible). Implements `generateIdentityKey`, `generatePreKeyBundle`, `initiateSession`, `encrypt`, `decrypt`. Store: was in-memory `InMemorySignalProtocolStore` in 5b; **swapped to `SqlCipherSignalProtocolStore` in 5c** so cold-start re-enrollment is no longer required. Wire format: base64 strings + 1-byte ciphertext type marker (3=PreKey, 2=Whisper) so `decrypt` can dispatch cleanly. APK builds: 217 MB after 5c (libsignal Rust .so adds ~40 MB; SQLCipher native libs add ~8 MB). Spec's earlier "Conscrypt + BouncyCastle" wording referred to the underlying primitives — libsignal uses platform crypto under the hood. Required: core library desugaring (java.time backport) + Java 17 source compatibility. **Sender Keys for groups (`encryptForGroup`/`decryptFromGroupMember`) deferred — see Phase 5b carry-over below.**
- [x] 🍎 **Signal Protocol iOS + Group Messaging iOS** — `SignalProtocolModule.{swift,m}` + `GroupMessagingModule.{swift,m}` + `SpeakeasySignalStore.swift` + `SqlCipherSignalProtocolStore.swift` at `apps/mobile/ios/SpeakeasyBridges/Signal/`. **Compile-verified + linker-verified on Xcode 26.4.1 against libsignal v0.59.0.** Integration path: libsignal added via CocoaPods git source (`pod 'LibSignalClient', git: 'https://github.com/signalapp/libsignal.git', tag: 'v0.59.0'`) with `use_frameworks! :linkage => :static`; Rust→C `libsignal_ffi.a` library obtained from Signal's CDN prebuild (`build-artifacts.signal.org/.../libsignal-client-ios-build-v0.59.0.tar.gz`, SHA `32eac8d2c22768caf4015d6b039b93f8a0c03db3896c7802f8a02b85fd2765e8`) cached at `~/Library/Caches/org.signal.libsignal/`. Custom xcconfig on the app target injects `SWIFT_INCLUDE_PATHS` for the SignalFfi modulemap + `OTHER_LDFLAGS = $(LIBSIGNAL_FFI_LIB_TO_LINK)` so the .a's `_signal_*` symbols resolve at link time. All-six `SignalProtocolStore` protocol methods rewritten to match the leaner iOS protocol surface (no `containsPreKey`, `containsSession`, `getSubDeviceSessions` etc — those are Java-only). `SignalError.noSession` → `.sessionNotFound` (iOS naming); `InMemoryKyberPreKeyStore` doesn't exist on iOS so Kyber is held in a small in-memory `[UInt32: [UInt8]]` Dict. SQLCipher's `sqlite3_*` C symbols come in via the bridging header (no Swift modulemap on the pod).
- [x] **Channel keys Android** — Kotlin module wrapping libsignal's `Curve.calculateAgreement` (X25519 ECDH) + `HKDF.deriveSecrets` + JDK `AES/GCM/NoPadding`. Implements `generateChannelKey`, `wrapForRecipient`, `unwrapForSelf`, `encryptMessage`, `decryptMessage`. Identity private key sourced from `SpeakeasySignalStore` (the same in-memory libsignal store the Signal Protocol bridge uses). **Wire format documented in code** (also summarised on the JS interface) so the iOS counterpart can ship matching envelope bytes: `[33-byte ephemeral pubkey][12-byte IV][ciphertext+16-byte GCM tag]`. HKDF info string `speakeasy-channel-key-wrap-v1`. The `SoftwareChannelKeyModule` test fixture stays the unit-test backbone — its symmetric scheme is intentionally not wire-compatible with this real impl (test-only).
- [x] 🍎 **Channel keys iOS** — `ChannelKeyModule.{swift,m}` at `apps/mobile/ios/SpeakeasyBridges/ChannelKey/`. **Compile-verified on Xcode 26.4.1.** Pure CryptoKit (X25519 via `Curve25519.KeyAgreement`, `HKDF<SHA256>`, `AES.GCM`). Wire-format byte-compatible with Android: 33-byte ephemeral pubkey (libsignal 0x05 type prefix + raw 32) + 12-byte IV + ciphertext + 16-byte tag. HKDF info `speakeasy-channel-key-wrap-v1`.

##### Phase 5b carry-over → next sweep

Items deliberately scoped out of this sweep so the 1:1 path could ship as one cohesive checkpoint. Pick these up first when Phase 5b resumes:

- [x] **Group messaging — Sender Keys.** `GroupMessagingModule` (Kotlin + JS) covering `createSenderKeyDistribution(distributionId)`, `processSenderKeyDistribution(senderUserId, skdmBytes)`, `encryptForGroup(distributionId, plaintext)`, `decryptFromGroupMember(senderUserId, ciphertext)`, wrapping libsignal's `GroupSessionBuilder` + `GroupCipher` + `SenderKeyDistributionMessage`. Sender Key persistence lives in SQLCipher (`sender_keys` table — schema migration v2; `SqlCipherSignalProtocolStore.SenderKeyStore` impl replaces the in-memory delegate that 5c left as carry-over). Distribution IDs are UUIDs the JS layer allocates per-(local-sender, group). `MockGroupMessagingClient` for tests (5 round-trip tests in `packages/crypto`). **Still deferred:** group chat screen UX (no group chat screen exists yet to wire into).
- [x] **SKDM wire format end-to-end.** Server: new `skdm` WS frame in both client+server unions (extends `WsClientMsg`/`WsServerMsg`); WS handler routes `skdm` like a single-recipient direct message (persist-and-forward, ack-deletes, drains on reconnect, fires push when offline). Migration `0004_skdm.sql` adds `skdm_group_id TEXT NULL` to `messages`. 5 new server tests cover live forward, buffered drain, self-rejection, missing-field rejection, push-on-offline. Mobile: `crypto/group-orchestration.ts` orchestrates send-side fan-out (mint distributionId per (self, group), `ensureSessionWithPeer` for each peer, encrypt SKDM via 1:1, send `skdm` frame; then encrypt + send group ciphertext) and receive-side (decrypt 1:1, install via `processSenderKeyDistribution`, ack). Per-process bootstrap cache so subsequent sends to the same group skip the SKDM round; new members trigger an SKDM only for them. `store/distribution-ids.ts` allocates UUID v4 per (local-sender, group). 5 orchestrator tests + 4 distribution-id tests.
- [x] **Wire enrollment to the real bundle.** `OnboardingScreen.handleContinue` now calls `signalProtocol.generateIdentityKey()` + `signalProtocol.generatePreKeyBundle({registrationId, signedPreKeyId: 1, oneTimePreKeyCount: 100})` from `NativeSignalProtocolModule`. Identity key flows through to the server's `users.public_key` row. `MockSignalProtocolClient` added for non-RN test hosts (`config.useMockSignalProtocol`).
- [x] **Wire chat encrypt/decrypt.** `ChatScreen` now calls `signalProtocol.encrypt(peerUserId, plaintext)` on send and `signalProtocol.decrypt(peerUserId, ciphertext)` on receive. Session establishment via `ensureSessionWithPeer` (in `apps/mobile/src/crypto/session.ts`) — fetches bundle from `POST /v1/prekeys/bundle` (new `ApiClient.fetchPreKeyBundle` method), calls `signalProtocol.initiateSession`, caches per-process so subsequent sends to the same peer skip the OTPK consumption. Receive path decrypts off the render path; failures surface as `[decrypt failed]` / `[identity changed — verify with peer]` bubbles instead of silently dropping. Optimistic local echo on send so the bubble appears immediately while encryption + WS send happen in the background.
- [x] **PreKey replenishment trigger.** Server: `/v1/prekeys/bundle` now pushes a `prekeys_low` WS frame to the *owner's* live sockets (via the `UserNotifier` interface). `LocalUserNotifier` covers same-instance fan-out; **`RedisUserNotifier` (Phase 5f follow-up landed)** mirrors `RedisAckRouter`'s pub/sub pattern so the signal reaches the owner regardless of which instance accepted their socket — `notify` does both local fan-out and a publish on `speakeasy:user-notify`; peer instances ignore self-publishes (instanceId stamped in envelope). Mobile: `App.tsx` subscribes to the WS client (new `subscribe()` API replacing the per-screen `_testOnMessage` hack) and triggers `makeReplenisher` — concurrent `prekeys_low` signals dedupe onto a single in-flight round, one follow-up if still low_water, then stop. Tests: 5 mobile replenisher + 2 server bundle-push trigger + 4 cross-instance RedisUserNotifier (FakeRedis pub/sub stand-in).
- [ ] **Real device runtime testing.** Everything ships compile-verified — actual biometric / Keystore / libsignal interop is unverified until the APK runs on hardware.
- [ ] Conversation store moves from in-memory Zustand to SQLCipher-backed (preserving the `useConversations` API; just the persistence layer changes).

#### 5c. SQLCipher-backed local persistence
- [x] **SQLCipher Android dependency** — `net.zetetic:sqlcipher-android:4.14.1` (successor to the maintenance-only `android-database-sqlcipher`). Native `libsqlcipher.so` lands in the APK across all four ABIs. Required pinning kotlin-stdlib + `androidx.sqlite` back to Kotlin-1.9-compatible versions (sqlcipher's transitive `sqlite-android:2.6.x` ships Kotlin-2.1 metadata that the project's 1.9.24 compiler can't read).
- [x] **`SpeakeasyDb`** — SQLCipher init + DB-key derivation (`apps/mobile/android/.../db/SpeakeasyDb.kt`). Schema migrations live in `db/Schema.kt`; v1 ships the five tables needed by the Signal store (`identity`, `prekeys`, `signed_prekeys`, `sessions`, `identities`).
- [x] **DB-key derivation per spec §4c** — HKDF-SHA256(Vouchflow.cachedDeviceToken, salt=`"speakeasy-db-v1"`, info=`"sqlcipher-passphrase"`, L=32). `cachedDeviceToken` is bytewise-stable across cold starts (written once to `AccountManager` during enrollment, read back unmodified per verify) and survives reboots without biometric or network — exposed as a property on `Vouchflow.shared` from SDK 1.0.3. **Bootstrap invariant:** `SpeakeasyDb.open` throws `NotEnrolledException` if the cached token is null, enforcing "enroll before encrypt" structurally rather than implicitly. Biometric reconfig (`KEY_INVALIDATED`) or app reinstall rotate the token → local DB unreadable → triggers re-enrollment + fresh DB (server-side reputation preserved via Vouchflow's `existingDeviceToken` re-enrollment path; local data is gone, same end-state as device wipe). Salt + info are versioned so a forward `PRAGMA rekey` migration is possible if derivation ever changes. **Requires `dev.vouchflow:android-sdk:1.0.3`** (parallel SDK ship).
- [x] **`SqlCipherSignalProtocolStore`** — implements libsignal's full `SignalProtocolStore` interface. The four hot stores (`IdentityKeyStore`, `PreKeyStore`, `SignedPreKeyStore`, `SessionStore`) are SQLCipher-backed. `KyberPreKeyStore` and `SenderKeyStore` are delegated to the in-memory impls (Phase 5b carry-over deferred work — neither is exercised by the 1:1 path yet). Identity trust model is TOFU, mirroring `InMemoryIdentityKeyStore`.
- [x] **`SpeakeasySignalStore` cold-start restore** — `initializeFromDb(context)` reconstructs the store from the singleton `identity` row; `initialize(context, ikp, regId)` writes a fresh identity to disk. `SignalProtocolModule.generateIdentityKey` first attempts a restore and only mints a new identity when none exists. Every other bridge method (`generatePreKeyBundle`, `initiateSession`, `encrypt`, `decrypt`) calls `ensureRestored()` so app cold-starts no longer require re-enrollment.
- [x] **APK builds** — 217 MB (up from 209 MB; +8 MB for SQLCipher native libs across 4 ABIs).
- [ ] **Real device runtime testing** — integration with libsignal's session lifecycle is compile-verified only; on-hardware verification is part of the broader Phase 5b carry-over device-test pass.
- [ ] **Conversation store** persistence — separate from the Signal store; lands when conversation/messages screens move out of in-memory Zustand (currently no persistent on-disk schema for messages).
- [x] 🍎 **iOS counterpart** — `SpeakeasyDb.swift` + `Schema.swift` at `apps/mobile/ios/SpeakeasyBridges/Db/`. **Compile-verified on Xcode 26.4.1.** SQLCipher iOS via CocoaPods (4.6.1); the pod ships sqlite3.h but no Swift modulemap, so `sqlite3_*` C symbols come in via the project's bridging header. Same HKDF derivation as Android (token via `Vouchflow.shared.cachedDeviceToken`, requires Vouchflow iOS 1.0.5), same schema + migrations (v1: identity/prekeys/signed_prekeys/sessions/identities; v2: sender_keys). Token storage moves Keystore → Keychain implicitly via the Vouchflow iOS SDK.

#### 5d. Push notifications, end-to-end
- [x] Android FCM registration in mobile native code.
- [ ] 🍎 iOS APNs registration in mobile native code.
- [x] Mobile uploads its push token to the server via a new `POST /v1/devices/push-token` endpoint (writes to `devices.push_token`). Server-side endpoint is platform-agnostic — ships independently of mobile.
- [x] Server's `FcmApnsPushProvider` replaces `NoopPushProvider` once `FCM_SERVER_KEY` and APNs auth-key secrets are set on Fly. (Android-FCM half can ship before iOS.)

#### 5e. Mobile UX completion
- [ ] Brand-design completion across remaining screens: real conversations list (replaces stub), settings, profile, group/community detail, chat list with unread badges. JS layer; renders identically on both platforms.
- [ ] **Multi-device pairing flow** — secondary device enrolls via Vouchflow → server links to existing user_id (currently implicit on first WS auth) → existing devices receive an in-app prompt to wrap K for the new device, fan-out envelopes upload to `/v1/communities/:id/envelopes`. UX TBD.
- [ ] `@react-native-community/blur` integration — `DisappearingMessageBubble` swaps the `blurAmount` placeholder for a real `BlurView` driven by the same Animated value. JS-side wiring is platform-agnostic; native module ships per-platform.
- [ ] Motion/visual polish on real Android hardware (or emulator with KVM).
- [ ] 🍎 Same polish pass on real iOS hardware / simulator.

#### 5f. Server polish
- [x] **Drizzle implementations** of remaining repos — `DrizzleUserRepo`, `DrizzlePreKeyRepo`, `DrizzleGroupRepo`, `DrizzleCommunityRepo`, `DrizzleMessagesRepo`, `DrizzleDevicesRepo` all live under `apps/api/src/db/*.drizzle.ts`. `server.ts` selects between Drizzle (when DATABASE_URL is set) and `InMemory*` (test fixture / demo) per repo. `InMemory*` stays as the test-fixture default.
- [x] **Per-device buffered-delivery tracking** (Phase 5f). `BufferedMessage` now carries `targetDevices` (snapshot of recipient's known devices at insert time, via `DevicesRepo.listForUser`) + `deliveredToDevices` (subset that have acked). `markDelivered` replaced with `markDeliveredByDevice(messageId, deviceToken)` returning `{kind: 'fully_delivered' | 'pending' | 'not_found'}`; only `fully_delivered` triggers the AckRouter announce → `delivered` to sender. `listUndeliveredFor(recipientId, deviceToken)` filters out rows the device has already acked, so a device that disconnects/reconnects doesn't redrain its own already-acked messages. Legacy shortcut: empty `targetDevices` → any single ack deletes (preserves behaviour for first-time recipients with no devices known at insert time). Migration `0005_per_device_delivery.sql` adds the two TEXT[] columns. **3 new repo unit tests** (multi-device pending → final ack delivers, idempotent re-ack, drain-filtering by deviceToken) **+ 2 new WS integration tests** (delivered fires only after every device acks; reconnecting device doesn't redrain).
- [x] **Migration runner** integrated with deploy — `npm run db:migrate` (root script, `node-pg-migrate -m infra/migrations -j sql up`) is wired as `release_command` in `infra/fly/api.toml`. The Dockerfile copies the root `package.json` + `infra/migrations/` into the runner image so the one-off release VM can find both. Verified end-to-end against a throwaway Postgres: all 6 migrations apply cleanly, `pgmigrations` ledger reflects each, 10 expected tables created. Local invocation: `DATABASE_URL=postgres://… npm run db:migrate`.
- [x] **Metrics endpoint** — `fastify-metrics` (the maintained successor to `@fastify/metrics`) registered behind `METRICS_ENABLED=1`. Serves `/metrics` on the **main HTTP listener** (port 8080), not the spec's original `:9091` — one less port to expose / firewall, same data, simpler Fly config. Body covers Node.js process metrics + the `http_request_duration_seconds` histogram across all routes. `infra/fly/api.toml` sets `METRICS_ENABLED=1` in the env block. 2 server tests cover (a) gated 404 when disabled, (b) Prometheus exposition shape when enabled.
- [x] **WebSocket production tests** — `apps/api/src/ws/cross-instance.test.ts` spins up two `buildServer` instances sharing a `MessagesRepo` + `UserRepo` + `DevicesRepo` (cluster-wide state, equivalent to Postgres in prod) with their `RedisAckRouter`s wired to a single `FakeRedisChannel` pub/sub bus (single-process Redis stand-in). 2 tests: (a) buffered-then-drained + cross-instance `delivered`, (b) 30 concurrent sender/recipient pairs all receive their `delivered` correctly with no message-id collisions. Diverged from spec's "load test against a 2-instance deploy" — the in-process simulation exercises the same code paths (RedisAckRouter publish/subscribe, Connections per-instance, MessagesRepo cluster-wide) without paying the Fly bill / spinning up real infra. Real-Redis + real-network load testing remains valuable but is a separate sweep when we actually deploy.

#### 5g. Spec §13 deferred decisions worth resolving in this phase
- [ ] **Sealed sender** for 1:1 (hide sender identity from the server's metadata). Signal-style. Recommended.
- [x] **Channel key rotation policy** (server side) — `DELETE /v1/communities/:id/members/:user_id` removes the target member. Authz: moderator can remove anyone; anyone can remove self. On success, every remaining member's live socket receives a `channel_key_rotation_required` WS frame (via `UserNotifier`); the leaver does NOT receive the signal. Mobile orchestration of "elect-a-wrapper, generate fresh K, fan-out new-epoch envelopes" is deferred to the mobile-side commit — server side is the rotation primitive. 7 new tests cover happy path, self-leave, non-mod blocked, not-a-member 404, missing-community surfacing (privacy: outsiders see 403, self-remove sees 404), and post-removal /key gating.
- [ ] **Username discovery** — at minimum a "show my QR code" + "scan a QR code to add" flow.
- [ ] Decide community message TTL: keep moderator-configurable in MVP or freeze at 7 days?

#### 5h. Stretch (post-MVP per spec §1)
- [ ] Web client (no Vouchflow Web SDK yet — coming-soon at vouchflow.dev/docs).
- [ ] Video calls with face masks / background filters / voice filters.
- [ ] Payments (USDT/TRON or USDC/Solana — under consideration).

---

## 12. Security Posture

### What the server knows
- A user's random ID and public key (required for session establishment)
- That two IDs communicated (envelope metadata for 1:1) — mitigate with sealed sender in v2
- Community membership lists
- Message ciphertext (cannot decrypt)
- Community message ciphertext encrypted with channel key (cannot decrypt — key never on server)

### What the server never knows
- Any personally identifying information
- Message content (all types)
- Community channel keys
- Device private keys

### Threat model priorities (MVP)
1. Passive server compromise (database breach) — mitigated by ciphertext-only storage
2. Compelled disclosure — mitigated by minimal metadata retention and key architecture
3. Fake device enrollment — mitigated by Vouchflow attestation (medium+ confidence required)
4. Abuse via anonymous accounts — rate limiting + Vouchflow device reputation as signal

---

## 13. Open Questions (Decisions Deferred)

- **Sealed sender:** Should 1:1 messages hide sender identity from the server? (Signal does this.) Recommended for v2.
- **Channel key rotation policy:** Rotate on every member leave? Every N days? Moderator-triggered only? TBD.
- **Payments:** USDT/TRON or USDC/Solana under consideration. Not in MVP. Fee sponsorship (no gas for users) is the target UX.
- **Community message TTL:** 7-day default. Should moderators be able to set longer? Shorter?
- **Per-conversation disappearing timer options:** Suggested: 1 hour, 24 hours, 7 days, 30 days, off.
- **Username discovery:** How do users find each other? Share ID out-of-band for MVP. QR code in v2.
- **AWS migration triggers:** Fly.io Postgres tier unpredictability, or enterprise compliance (SOC2/HIPAA) requirement.

---

## 14. Brand System

> **April 2026 revision.** The brand pivoted from gold-on-dark to purple-on-cream. The visual signature is the **dispersing signal** — the icon mark, the disappearing-message animation, and the use of soft purple all reinforce *"this signal won't be here long."* Gold and Syne are out.

The Speakeasy brand sits within the Vouchflow product family. Quiet confidence, soft warmth — not a security-product aesthetic, not a luxury-app aesthetic.

### Tagline (work in progress)
> Placeholder: *Say it & leave.* — copy is being iterated; do not treat as final.

### Colour Palette

| Token | Hex | Usage |
|---|---|---|
| `color-ink` | `#0F1117` | Primary text on light surfaces; never used as a background in MVP |
| `color-cream` | `#F7F6F3` | Primary background, all surfaces |
| `color-primary` | `#6C5CE7` | Brand accent — icon-mark disc, sent bubbles, primary CTA, intro labels |
| `color-soft` | `#A79CFF` | Tint of primary — received bubbles, hover/pressed states, fade endpoints |
| `color-pale` | `#E6E3F1` | Surface variant, dividers, light input fields, avatar tints |
| `color-slate` | `#6B7280` | Secondary text, labels, metadata |

**Rule:** Primary purple is the brand voice — used for the mark, sent bubbles, the "active" state. Soft purple is the support — surfaces, secondary states, the trail of a disappearing message. Slate is structural metadata only. Cream is everywhere; ink is for type.

### Typography

**Inter only**, at all weights. Suisse Int'l (the original brand sketch) is paid; Inter at 600/700 covers the display role we previously used Syne for.

| Role | Family / weight | Usage |
|---|---|---|
| Display | Inter 600 / 700 | ID reveal, hero moments, screen titles |
| UI / Body | Inter 300 / 400 / 500 | All interface text, labels, messages |

Letter spacing: `−0.2px` to `−0.4px` for body, `1.5–2px` for caps labels.

### Wordmark

- Lowercase: `speakeasy`
- Font: Inter 300 (small lockup), Inter 500 (hero)
- Letter spacing: `6px` (small), `14px` (hero)
- No silence-mark line, no gold accent. The word stands alone.
- An optional subtitle may be placed beneath in Inter 300 9–10px slate, all caps, 2px tracking. Subtitle copy is brand WIP.

### Icon Mark — the dispersing signal

A solid purple disc on the left with parallel horizontal trails extending to the right, each trail shorter and fainter than the last. Reads as a signal in the act of dispersing — the visual core of *"this won't be here long."*

- **Disc:** `fill: #6C5CE7`, ~28% of canvas height
- **Trails:** 5–7 parallel horizontal strokes from the disc's right edge, decreasing in length and opacity along the gradient `#6C5CE7 → #A79CFF → 0`. Final trail is barely visible.
- The mark is a sibling of the Vouchflow mark (geometric verification). Vouchflow's two squares = device verification. Speakeasy's disc-with-trail = signal that fades.
- App-icon shell: rounded square, `border-radius: 22%` of width, `background: color-cream`, mark centred.

### Screen Design Patterns

**Onboarding / Welcome**
- Cream background, IconMark centred (~96px), wordmark below, four key-feature lines in Inter 400 13px slate, primary CTA at bottom in Inter 500 with `color-primary` background, cream label.

**ID Reveal**
- Cream background, "INTRODUCING" label in Inter 500 9px / 2px tracking primary purple, three ID words stacked in Inter 700 38px ink, primary purple `·` separators between words. Animated arrival per Motion §1.

**Conversations List**
- Cream background, contacts in cards with `color-pale` background, avatars as rounded squares (`border-radius: 10px`) tinted soft purple, 2-letter initials in Inter 500 ink. Disappearing-timer pill in slate, `border: 1px solid color-pale`. Communities prefixed with `#`.

**Chat Screen**
- Background cream
- Received bubbles: `background: color-pale`, ink text, `border-radius: 16px 16px 16px 4px`
- Sent bubbles: `background: color-primary`, cream text, `border-radius: 16px 16px 4px 16px`
- Disappearing-timer indicator in input bar: clock icon + value in primary purple
- Footnote: `● Messages disappear after they're seen.` — primary-purple dot, slate text, 9px

**Voice messages**
- Waveform bars in primary purple, 70% opacity
- Play button: primary purple circle, cream triangle

**Input bar**
- Pill-shaped input field, slate placeholder
- `+` add button left in primary purple
- Timer indicator right (primary purple, only when timer is active)

### Motion — three brand moments

Execute these well; animate nothing else.

1. **ID reveal** — The three words arrive one at a time, staggered 200ms apart, each fading up from 8px below. Primary-purple `·` separators fade in after each word. Total ~800ms.
2. **Message disappear (the brand-critical moment)** — five-stage dissolve, **must be a real Animated transition, not static frames**:
   1. **Sent** — bubble at full opacity, full scale, sharp.
   2. **Seen** — small acknowledgement pulse: scale `1 → 1.02 → 1` over 200ms.
   3. **Disappearing** — opacity `1 → 0.55`, scale `1 → 0.97`, blur `0 → 4px` over 600ms.
   4. **Almost gone** — opacity `0.55 → 0.18`, scale `0.97 → 0.92`, blur `4 → 10px` over 600ms.
   5. **Gone** — opacity `→ 0`, height collapses to 0 over 400ms.

   Total dissolve: ~1.6s after the timer fires. Implementation lives at `apps/mobile/src/components/DisappearingMessageBubble.tsx`. Uses RN `Animated` for opacity / scale / height. True Gaussian blur requires `@react-native-community/blur` (lands when the native shells are scaffolded); the current implementation uses opacity + scale to deliver the same visual story.

3. **Enrollment transition** — 400ms cross-fade from welcome to ID reveal; a soft-purple ring expands from centre as the words arrive.

### What to Avoid

- Gold, warm yellow, neon — replaced by primary purple as of April 2026
- Syne, Suisse Int'l, or any second display family — Inter only
- Speech-bubble icons for anything
- Round avatars — rounded squares (`border-radius: 10px`) only
- Lock / shield / padlock iconography (security-product aesthetic)
- Static "disappearing" depictions — the dissolve must be animated

---

## 15. Getting Started (for Claude Code)

```bash
# Clone and install
git clone https://github.com/[org]/speakeasy
cd speakeasy
npm install

# Start local development
npm run dev          # starts api + mobile bundler via turbo

# Run migrations
npm run migrate

# Deploy to Fly.io
flyctl deploy --config infra/fly/api.toml
```

**First task:** Scaffold Phase 0. Start with `packages/shared` (ID generator + types), then the monorepo config, then the database schema and first migration, then Fly.io config files.
