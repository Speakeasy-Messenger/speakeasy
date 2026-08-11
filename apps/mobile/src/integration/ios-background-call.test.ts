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
    expect(delegate).toContain('withCompletionHandler:loggedCompletion');
    expect(delegate).toContain('CallKit incoming-call report completion');
    expect(delegate).toContain('[[NSUUID alloc] initWithUUIDString:uuid]');
  });

  it('keeps video capture eligible while the app is backgrounded in PiP', () => {
    const delegate = source('ios/Speakeasy/AppDelegate.mm');
    const plist = source('ios/Speakeasy/Info.plist');
    const entitlements = source('ios/Speakeasy/Speakeasy.entitlements');
    const screen = source('src/screens/VideoCallScreen.tsx');
    const webrtcPatch = source('patches/react-native-webrtc+124.0.7.patch');

    expect(delegate).toContain('enableMultitaskingCameraAccess = YES');
    expect(plist).toContain('<string>voip</string>');
    expect(entitlements).toContain(
      '<key>com.apple.developer.avfoundation.multitasking-camera-access</key>',
    );
    expect(entitlements).toContain('<true/>');
    // iOS AVKit owns the RTCView carrying `iosPIP`. Switching to the Android
    // compact renderer during UIApplicationState.inactive unmounts that source
    // view, which immediately tears down PiP and revokes background camera use.
    expect(screen).toContain("Platform.OS === 'android' &&");
    expect(screen).toContain('inPip || appBackgrounded ||');
    // AVKit rejects a video-call PiP source whose preferred content size is
    // zero. react-native-webrtc defaults an omitted preferredSize to
    // CGSizeZero, so keep the app-level contract explicit and portrait-sized.
    expect(screen).toContain('preferredSize: { width: 1080, height: 1920 }');
    expect(webrtcPatch).toContain('will resign active (possible=%@ active=%@ auto=%@)');
    expect(webrtcPatch).toContain('pictureInPicturePossible');
    expect(webrtcPatch).toContain('self.sampleView.shouldRender = YES');
    // AVKit owns the automatic inline-to-PiP transition. A second manual start
    // raced it on real iOS 18 devices and failed with error -1001.
    expect(webrtcPatch).not.toContain('[self.pipController startPictureInPicture]');
    expect(webrtcPatch).not.toContain('auto-start fallback requested');
    expect(webrtcPatch).toContain('UIApplicationDidBecomeActiveNotification');
    expect(webrtcPatch).toContain('A transient interruption can prime rendering');
    // Every Core Foundation object created for a PiP frame is released,
    // including when AVKit applies renderer backpressure.
    expect(webrtcPatch).toContain('if (self.renderer.readyForMoreMediaData)');
    expect(webrtcPatch).toContain('CFRelease(sampleBuffer);');
    expect(webrtcPatch).toContain('CFRelease(formatDescription);');
    expect(webrtcPatch).toContain('if (sampleStatus != noErr || sampleBuffer == NULL)');
    // A signed real-device run exposed WebRTCModuleOptions arriving false even
    // with the capability + entitlement present. The capture controller now
    // treats live session support as authoritative and verifies the applied
    // value in diagnostics before capture starts.
    expect(webrtcPatch).toContain('BOOL enable = requested || supported;');
    expect(webrtcPatch).toContain('multitasking requested=%@ supported=%@ target=%@ enabled=%@');
    // PiP must receive at least one foreground frame. Waiting until the
    // resign-active transition races camera suspension and yields black AVKit.
    expect(webrtcPatch).toContain('_sampleView.shouldRender = videoTrack != nil;');
    expect(webrtcPatch).toContain('[SpeakeasyPIPRenderer]');
  });

  it('resizes Android PiP video in place using platform-native seamless resizing', () => {
    const screen = source('src/screens/VideoCallScreen.tsx');
    const activity = source('android/app/src/main/java/xyz/speakeasyapp/app/MainActivity.kt');

    expect(activity).toContain('builder.setSourceRectHint(sourceRect)');
    expect(activity).toContain('.setSeamlessResizeEnabled(true)');
    expect(screen).toContain('key={`pip-${pipFeedTag}`}');
    expect(screen).toContain('style={StyleSheet.absoluteFill}');
    expect(screen).not.toContain('npip-${nativePipSize.w}x${nativePipSize.h}');
    expect(screen).not.toContain('{ width: nativePipSize.w, height: nativePipSize.h }');
  });

  it('restores the iOS call and ends it when the native PiP close control is used', () => {
    const webrtcPatch = source('patches/react-native-webrtc+124.0.7.patch');
    const delegate = source('ios/Speakeasy/AppDelegate.mm');
    const diagnosticsModule = source('ios/SpeakeasyBridges/Version/VersionModule.swift');
    const pipBridge = source('src/native/pip.ts');

    expect(webrtcPatch).toContain('completionHandler(YES);');
    expect(webrtcPatch).toContain('SpeakeasyPictureInPictureClosed');
    expect(delegate).toContain('speakeasyPictureInPictureClosed:');
    expect(diagnosticsModule).toContain('forKey: "SpeakeasyPendingPipClose"');
    expect(diagnosticsModule).toContain('final class NativeDiagnosticsModule: RCTEventEmitter');
    expect(diagnosticsModule).toContain('sendEvent(withName: "SpeakeasyPipClosed"');
    expect(pipBridge).toContain("emitter.addListener('SpeakeasyPipClosed'");
    expect(pipBridge).toContain('consumePendingPipClose(sessionId)');
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
    const androidCloseFlow = source('maestro/22-call-pip-close-android.yaml');
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
    expect(androidActivity).toContain('BuildConfig.SPEAKEASY_VIDEO_CALL_HARNESS');
    expect(androidGradle).toContain("project.findProperty('speakeasy.videoCallHarness')");
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
    expect(androidWorkflow).toContain('22-call-pip-close-android.yaml');
    expect(androidCloseFlow).toContain("tapOn: 'Close'");
    expect(androidCloseFlow).toContain("assertNotVisible: '@dev-peer'");
    expect(maestroFlow).toContain("id: 'video-call-pip'");
    expect(maestroFlow).toContain("id: 'harness-arm-background-video'");
    expect(maestroFlow).toContain("id: 'harness-background-video-measuring'");
    expect(
      maestroFlow.indexOf("text: 'Allow'", maestroFlow.indexOf('local-network prompt')),
    ).toBeLessThan(
      maestroFlow.indexOf(
        "id: 'harness-arm-background-video'",
        maestroFlow.indexOf('local-network prompt'),
      ),
    );
    expect(maestroFlow).toContain('stopApp: false');
    expect(maestroFlow).toContain("id: 'harness-background-video-pass'");
    expect(maestroFlow).not.toContain("id: 'video-call-end'");
  });

  it('persists enough breadcrumbs to diagnose a real-device background call', () => {
    const delegate = source('ios/Speakeasy/AppDelegate.mm');
    const bridge = source('src/calls/callkeep-bridge.ts');
    const peer = source('src/calls/webrtc-peer.ts');
    const screen = source('src/screens/VideoCallScreen.tsx');
    const diagnosticsScreen = source('src/screens/DiagnosticsScreen.tsx');
    const webrtcPatch = source('patches/react-native-webrtc+124.0.7.patch');

    expect(delegate).toContain('VoIP push received');
    expect(delegate).toContain('CallKit incoming-call report completion');
    expect(bridge).toContain("diag('callkeep', 'didDisplayIncomingCall'");
    expect(bridge).toContain("diag('callkeep', 'displayIncomingCall requested'");
    expect(screen).toContain("diag('call', 'app state change during video call'");
    expect(screen).toContain("diag('call', 'pip closed → hangup'");
    expect(peer).toContain('video stats @ ${trigger}');
    expect(peer).toContain('inboundFlowing:');
    expect(peer).toContain('outboundFlowing:');
    expect(peer).toContain("scheduleVideoStats('background-boundary')");
    expect(peer).toContain("scheduleVideoStats('foreground-boundary')");
    expect(peer).toContain('backgroundInterval,');
    expect(screen).toContain('pip.drainNativeDiagnostics()');
    expect(webrtcPatch).toContain('iOS PiP: ');
    expect(webrtcPatch).toContain('failed to start');
    expect(webrtcPatch).toContain('controller dealloc');
    expect(webrtcPatch).toContain('iOS PiP renderer: ');
    expect(webrtcPatch).toContain('first frame');
    expect(webrtcPatch).toContain('decode failed');
    expect(webrtcPatch).toContain('iOS camera: ');
    expect(webrtcPatch).toContain('AVCaptureSessionWasInterruptedNotification');
    expect(diagnosticsScreen).toContain('pip.drainNativeDiagnostics()');
  });
});
