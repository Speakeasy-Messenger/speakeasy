import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-level contract for the mic-foreground capture gate
 * (call-01M2N41QF1P7BE6HSWR152SMRG, diag build v1.0.74-rc.2).
 *
 * On that build, AudioRecord capture started while the app was backgrounded
 * with NO microphone foreground service (Android 14+ "while-in-use" rules
 * muted the stream permanently): outbound audio was all-zero RMS and the
 * remote (and we) received no audio RTP in either direction, while video
 * flowed fine over the same connection.
 *
 * The behavioural tests (orchestrator.test.ts, mic-foreground.test.ts)
 * exercise the gate through injected deps. These assertions pin the
 * production wiring itself — that the orchestrator's default gate IS the
 * real mic-foreground gate and that the gate never resolves `true` without
 * an ActivityManager-confirmed microphone FGS — because a refactor that
 * silently drops the default wiring would leave every injected-stub test
 * green while shipping the bug again.
 */
const read = (f: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), f), 'utf8');

const ORCHESTRATOR = read('orchestrator.ts');
const MIC_FG = read('mic-foreground.ts');
const APP = read('../../App.tsx');

describe('mic-FGS capture gate wiring', () => {
  it('orchestrator gates BOTH directions through the real gate (static import, default dep)', () => {
    expect(ORCHESTRATOR).toContain("import { ensureMicForegroundService } from './mic-foreground.js'");
    // The production default must be the real gate — not a pass-through.
    expect(ORCHESTRATOR).toMatch(
      /ensureMicForegroundService\s*\?\?\s*ensureMicForegroundService/,
    );
  });

  it('the gate is awaited BEFORE the peer is created on both startOutgoing and accept', () => {
    // startOutgoing: gate call must appear before createOffer.
    const startOutgoing = ORCHESTRATOR.slice(
      ORCHESTRATOR.indexOf('async startOutgoing('),
      ORCHESTRATOR.indexOf('async accept('),
    );
    expect(startOutgoing).toMatch(/await this\.ensureMicForegroundReady\(/);
    // Compare against the actual call site, not the explanatory comments
    // ("capture begins inside peer.createOffer()") that precede the gate.
    expect(startOutgoing.indexOf('await this.ensureMicForegroundReady(')).toBeLessThan(
      startOutgoing.indexOf('await peer.createOffer()'),
    );
    // accept: gate call must appear before createAnswer.
    const accept = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('async accept('));
    expect(accept).toMatch(/await this\.ensureMicForegroundReady\(/);
    expect(accept.indexOf('await this.ensureMicForegroundReady(')).toBeLessThan(
      accept.indexOf('await peer.createAnswer()'),
    );
  });

  it('the gate never reports success without confirming the microphone FGS is active', () => {
    expect(MIC_FG).toContain('isMicrophoneForegroundServiceActive');
    // Exactly two `return true` exits: the non-Android pass-through and the
    // CONFIRMED branch — nothing else may resolve success.
    expect(MIC_FG.match(/return true/g)).toHaveLength(2);
    expect(MIC_FG).toMatch(/if \(confirmed === true\)/);
    // And the timeout path must resolve false (failure-closed).
    expect(MIC_FG).toMatch(/return false/);
  });

  it('App.tsx no longer owns FGS startup (moved into the orchestrator gate)', () => {
    // The old App.tsx subscriber started the pill FGS at outgoing_dialing —
    // racing capture. If pill-start ownership creeps back here, the gate can
    // be observed "already active" before its own start call and a
    // still-backgrounded start slips through unconfirmed.
    expect(APP).not.toMatch(/pillStart/);
  });
});
