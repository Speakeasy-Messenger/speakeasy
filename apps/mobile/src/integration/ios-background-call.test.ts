import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');

function source(relativePath: string): string {
  return readFileSync(resolve(mobileRoot, relativePath), 'utf8');
}

describe('iOS background-call native contracts', () => {
  it('configures CallKit before PushKit can deliver a killed-launch call', () => {
    const delegate = source('ios/Speakeasy/AppDelegate.mm');

    expect(delegate).toContain('[RNCallKeep setup:@{');
    expect(delegate).toContain('[RNVoipPushNotificationManager voipRegistration];');
    expect(delegate.indexOf('[RNCallKeep setup:@{')).toBeLessThan(
      delegate.indexOf('[RNVoipPushNotificationManager voipRegistration];'),
    );
    expect(delegate).toContain('[RNCallKeep reportNewIncomingCall:uuid');
    expect(delegate).toContain('withCompletionHandler:completion');
    expect(delegate).toContain('[[NSUUID alloc] initWithUUIDString:uuid]');
  });

  it('keeps video capture eligible while the app is backgrounded in PiP', () => {
    const delegate = source('ios/Speakeasy/AppDelegate.mm');
    const plist = source('ios/Speakeasy/Info.plist');
    const entitlements = source('ios/Speakeasy/Speakeasy.entitlements');

    expect(delegate).toContain('enableMultitaskingCameraAccess = YES');
    expect(plist).toContain('<string>voip</string>');
    expect(entitlements).toContain(
      '<key>com.apple.developer.avfoundation.multitasking-camera-access</key>',
    );
    expect(entitlements).toContain('<true/>');
  });

  it('lets CallKit own the iOS audio session instead of InCallManager', () => {
    const peer = source('src/calls/webrtc-peer.ts');
    const bridge = source('src/calls/callkeep-bridge.ts');

    expect(peer).toContain("if (Platform.OS !== 'ios') {");
    expect(peer).toContain('InCallManager.start({ media, auto: true });');
    expect(bridge).toContain('wm?.setManualAudio?.(true);');
    expect(bridge).toContain("addEventListener('didActivateAudioSession'");
    expect(bridge).toContain('audioSessionDidActivate()');
  });

  it('registers PushKit independently of ordinary notification permission', () => {
    const registration = source('src/push/register.ts');
    const voip = source('src/push/voip-push.ts');
    const registerBody = registration.slice(
      registration.indexOf('async function doRegisterPushToken'),
    );

    expect(registerBody.indexOf('startVoipPush({')).toBeLessThan(
      registerBody.indexOf('pushNotifications.getToken()'),
    );
    expect(voip).toContain("addEventListener('didLoadWithEvents'");
    expect(voip).toContain('prewarmForIncomingCall');
  });

  it('keeps the real-device video harness behind native build flags', () => {
    const app = source('App.tsx');
    const delegate = source('ios/Speakeasy/AppDelegate.mm');
    const fastfile = source('ios/fastlane/Fastfile');
    const projectWiring = source('ios/tools/wire-ios-project.rb');
    const workflow = source('../../.github/workflows/browserstack-ios.yml');
    const androidWorkflow = source('../../.github/workflows/browserstack-android.yml');
    const maestroFlow = source('maestro/20-call-pip-ios.yaml');
    const androidActivity = source(
      'android/app/src/main/java/xyz/speakeasyapp/app/MainActivity.kt',
    );
    const androidGradle = source('android/app/build.gradle');
    const harness = source('src/screens/DevVideoCallHarness.tsx');

    expect(app).toContain('videoCallHarness?: boolean;');
    expect(delegate).toContain('#if SPEAKEASY_VIDEO_CALL_HARNESS');
    expect(fastfile).toContain('lane :browserstack do');
    expect(fastfile).toContain('SPEAKEASY_VIDEO_CALL_HARNESS_ENABLED=1');
    expect(fastfile).not.toContain("xcargs: 'GCC_PREPROCESSOR_DEFINITIONS=");
    expect(projectWiring).toContain(
      'SPEAKEASY_VIDEO_CALL_HARNESS=$(SPEAKEASY_VIDEO_CALL_HARNESS_ENABLED)',
    );
    expect(androidActivity).toContain(
      'BuildConfig.SPEAKEASY_VIDEO_CALL_HARNESS',
    );
    expect(androidGradle).toContain(
      "project.findProperty('speakeasy.videoCallHarness')",
    );
    expect(harness).toContain('new RTCPeerConnection({ iceServers: [] })');
    expect(harness).toContain('readInboundVideoStats');
    expect(harness).toContain('pip.onPipModeChanged');
    expect(harness).toContain('if (!baseline) return;');
    expect(harness).toContain('harness-arm-background-video');
    expect(harness).toContain('harness-evaluate-background-video');
    expect(workflow).toContain('zip -qr ../speakeasy-ios-calls.zip speakeasy-ios-calls');
    expect(workflow).toContain('apps/mobile/build/speakeasy-ios-calls.zip');
    expect(androidWorkflow).toContain('-Pspeakeasy.videoCallHarness=true');
    expect(androidWorkflow).toContain('speakeasy-android-calls.zip');
    expect(maestroFlow).toContain("id: 'video-call-pip'");
    expect(maestroFlow).toContain("id: 'harness-arm-background-video'");
    expect(maestroFlow).toContain("tapOn: 'Speakeasy'");
    expect(maestroFlow).toContain("id: 'harness-background-video-pass'");
    expect(maestroFlow).not.toContain("id: 'video-call-end'");
  });
});
