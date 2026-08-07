import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Regression guard for the never-connects outage.
 *
 * `bc76ebf` ("force TURN relay when available") set
 * `iceTransportPolicy: hasTurn ? 'relay' : 'all'`, which made the client
 * relay-ONLY whenever a TURN server was issued — the normal case. If the
 * relay path didn't work end-to-end for BOTH peers, ICE nominated no
 * candidate pair and the call hung on "connecting" forever with no direct
 * fallback. `3092e14` (#188) restored `'all'`.
 *
 * That fix lived only on `main` while the PiP/NSE work lived on a branch,
 * and reconciling the two lines (PR #192) re-merged the file that carried
 * the bug. A source-level assertion is the right shape here because the
 * value is a static config constant, not behaviour reachable from the
 * orchestrator's injected peer factory — the real `RTCPeerConnection` is
 * never constructed in this suite, so no behavioural test would see it.
 *
 * If this fails: do NOT "fix" it by editing the test. Direct-first with a
 * relay fallback is what makes ~70-80% of mobile calls connect at all.
 */
const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'webrtc-peer.ts'),
  'utf8',
);

describe('webrtc-peer ICE transport policy', () => {
  it("configures iceTransportPolicy: 'all' exactly once", () => {
    const assignments = SOURCE.match(/iceTransportPolicy:\s*[^,\n]+/g) ?? [];
    expect(assignments).toEqual(["iceTransportPolicy: 'all'"]);
  });

  it('never forces relay-only transport', () => {
    // Catches the exact regression shape (`hasTurn ? 'relay' : 'all'`) and
    // any other literal that would pin the client to relay candidates.
    expect(SOURCE).not.toMatch(/iceTransportPolicy:\s*(['"]relay['"]|[^,\n]*\?)/);
  });
});
