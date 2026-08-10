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

  it('keeps the real-device video harness behind a native build flag', () => {
    const app = source('App.tsx');
    const delegate = source('ios/Speakeasy/AppDelegate.mm');
    const fastfile = source('ios/fastlane/Fastfile');

    expect(app).toContain('videoCallHarness?: boolean;');
    expect(delegate).toContain('#ifdef SPEAKEASY_VIDEO_CALL_HARNESS');
    expect(fastfile).toContain('lane :browserstack do');
    expect(fastfile).toContain('SPEAKEASY_VIDEO_CALL_HARNESS=1');
  });

  it('repairs GoogleDataTransport 10.1.0 nanopb compilation during pod install', () => {
    const podfile = source('ios/Podfile');

    expect(podfile).toContain("'GDTCORMetrics+GDTCCTSupport.m'");
    expect(podfile).toContain('#define PB_ENABLE_MALLOC 1');
  });
});
