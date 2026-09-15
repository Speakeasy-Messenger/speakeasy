import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('resolves drain/snapshot through the bridge, never with raw Kotlin collections', () => {
    // The RN bridge only accepts String, Boolean, Double, Integer, WritableMap,
    // WritableArray and null as a resolved value. On fcf05a8 the module resolved
    // the store's raw List<LinkedHashMap> and every drain()/snapshot() threw
    // "Cannot convert argument of type class ..." ("class m5.z" = minified
    // Kotlin ArrayList), so no native records ever reached the diag buffer.
    // Pin the conversion on the resolve path: drain() must build a WritableArray
    // of per-entry maps and snapshot() must wrap the store map in makeNativeMap,
    // which recursively converts nested maps/lists, coerces Long/Float to
    // Double, and keeps null fields as explicit nulls.
    const module = source(
      'apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/audiodiag/AudioDiagnosticsModule.kt',
    );
    expect(module).toMatch(
      /fun drain\(promise: Promise\)\s*\{[\s\S]*?Arguments\.createArray\(\)[\s\S]*?Arguments\.makeNativeMap\(entry\)[\s\S]*?promise\.resolve\(array\)\s*\}/,
    );
    expect(module).toMatch(
      /fun snapshot\(trigger: String, promise: Promise\)\s*\{\s*promise\.resolve\(Arguments\.makeNativeMap\(AudioDiagnosticsStore\.snapshot\(context, trigger\)\)\)\s*\}/,
    );
    // The raw store return values must never be passed to resolve() directly.
    expect(module).not.toMatch(/promise\.resolve\(\s*AudioDiagnosticsStore\./);
  });

  it('returns actual iOS manual-audio, activation and route state', () => {
    const patch = source('apps/mobile/patches/react-native-webrtc+124.0.7.patch');
    const bridge = source('apps/mobile/src/calls/callkeep-bridge.ts');
    expect(patch).toContain('SpeakeasyAudioSessionSnapshot');
    expect(patch).toContain('@"manualAudio"');
    expect(patch).toContain('@"isAudioEnabled"');
    expect(patch).toContain('@"currentOutputPorts"');
    expect(bridge).toContain("'provider activated audio session'");
    expect(bridge).toContain('activatedSinceCallBegan');
    expect(bridge).toContain('audioOwnerActual');
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
