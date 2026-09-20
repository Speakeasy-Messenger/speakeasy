import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('paired call-audio native bridge wiring', () => {
  it('wires Android focus, capture, playout and route events into the bounded bridge', () => {
    const app = source('apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/MainApplication.kt');
    const store = source('apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/audiodiag/AudioDiagnosticsStore.kt');
    const record = source('apps/mobile/android/app/src/main/java/org/webrtc/audio/WebRtcAudioRecord.java');
    const track = source('apps/mobile/android/app/src/main/java/org/webrtc/audio/WebRtcAudioTrack.java');
    const focusPatch = source('apps/mobile/patches/react-native-incall-manager+4.2.1.patch');
    expect(app).toContain('add(AudioDiagnosticsPackage())');
    expect(store).toContain('MAX_PENDING = 100');
    expect(store).toContain('effectiveCommunicationDevice');
    expect(record).toContain('capture samples');
    expect(record).toContain('capture read error');
    expect(track).toContain('playbackHeadDelta');
    expect(track).toContain('underrunCount');
    expect(focusPatch).toContain('SpeakeasyAudioFocusDiagnostics');
    expect(focusPatch).toContain('focus requested');
  });

  it('ships an incall-manager patch that applies to the installed package', () => {
    const patchRelPath = 'apps/mobile/patches/react-native-incall-manager+4.2.1.patch';
    const patchPath = resolve(root, patchRelPath);
    const patch = source(patchRelPath);
    expect(patch.match(/^\+\+\+ b\//gm)).toHaveLength(1);
    const target = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? '';
    expect(target).not.toBe('');
    const installRoot = resolve(
      dirname(
        createRequire(resolve(root, 'apps/mobile/package.json')).resolve(
          'react-native-incall-manager/package.json',
        ),
      ),
      '../..',
    );
    // git apply silently ignores patch paths outside its working directory, so
    // stage the installed file at the patch's own path outside any repository.
    const sandbox = mkdtempSync(join(tmpdir(), 'incall-patch-'));
    try {
      const staged = join(sandbox, target);
      mkdirSync(dirname(staged), { recursive: true });
      copyFileSync(resolve(installRoot, target), staged);
      const check = (...args: string[]) => {
        try {
          execFileSync('git', ['apply', '--check', ...args, patchPath], {
            cwd: sandbox,
            stdio: 'pipe',
          });
          return null;
        } catch (error) {
          return String((error as { stderr?: Buffer }).stderr ?? error);
        }
      };
      const applies = check();
      const alreadyApplied = check('--reverse');
      expect(
        applies === null || alreadyApplied === null,
        `patch neither applies to nor matches the installed package:\n${applies}\n${alreadyApplied}`,
      ).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('enables uploads only in explicitly-built beta artifacts on both platforms', () => {
    const workflow = source('.github/workflows/release-play.yml');
    const android = source('apps/mobile/android/app/build.gradle');
    const fastfile = source('apps/mobile/ios/fastlane/Fastfile');
    expect(workflow).toContain("tags: ['alpha-*', 'v*', 'diag-*']");
    expect(workflow).toContain('-Pspeakeasy.diagnosticsBeta="$diagnostics_beta"');
    expect(workflow).toContain('SPEAKEASY_DIAGNOSTICS_BETA:');
    expect(android).toContain('SPEAKEASY_DIAGNOSTICS_BETA');
    expect(fastfile).toContain('SPEAKEASY_DIAGNOSTICS_BETA=YES');
  });

  it('samples modestly and tears down every sampling/native subscription', () => {
    const peer = source('apps/mobile/src/calls/webrtc-peer.ts');
    expect(peer).toContain("setInterval(() => this.scheduleAudioStats('periodic'), 2_000)");
    expect(peer).toContain('clearInterval(this.audioDiagTimer)');
    expect(peer).toContain('this.stopAudioDiagnostics()');
    expect(peer).toContain('this.nativeAudioUnsub?.()');
    expect(peer).toContain('audioDiagnostics.stop(this.callId)');
  });
});
