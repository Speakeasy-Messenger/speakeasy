# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- iOS CallKit/PushKit ownership and the required physical-device verification
  live in `apps/mobile/ios/PARITY.md`; keep native and JS call changes aligned
  with that contract.
- The Vouchflow device-confidence floor is set in four coupled places and must
  stay in agreement, or onboarding dead-ends: the vouchflow.dev dashboard, the
  client's `minimumConfidence` (`apps/mobile/src/auth/claim-handle.ts`),
  `MIN_CONFIDENCE` in `packages/vouchflow/src/types.ts`, and the server default
  + guard in `apps/api/src/{server,production-guard}.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
