#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
// Deep links: forwards inbound URLs to RN's Linking so App.tsx's handler
// (→ utils/handle-link parseAdd) sees them. Covers BOTH the custom scheme
// (speakeasy://add?handle=…, via openURL) AND Universal Links
// (https://speakeasyapp.xyz/add?handle=…, via continueUserActivity — paired
// with the applinks:speakeasyapp.xyz Associated-Domains entitlement + the
// hosted apple-app-site-association). Without these forwards iOS drops the
// link and the app never routes it.
#import <React/RCTLinkingManager.h>
// RN 0.77: RCTAppDelegate now requires a dependency provider (it feeds
// the new-architecture module/codegen registry). The pod is pulled in
// automatically by use_react_native! in the Podfile. Set it in
// didFinishLaunchingWithOptions before calling super, or the bridge
// startup hits a nil dependencyProvider.
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
// Phase 5j: must come BEFORE Speakeasy-Swift.h — the generated
// bridging header declares
//   @interface SpeakeasyAudioDevice (SWIFT_EXTENSION(Speakeasy))
//   <RTCAudioDevice>
// (the RTCAudioDevice conformance lives in a Swift extension on the
// class); ObjC needs RTCAudioDevice in scope to compile that line.
#import <WebRTC/WebRTC.h>
// Phase 5j PR-G — VoiceFilterModule extends RCTEventEmitter (so it
// can emit `SpeakeasyVoiceFilterFeatures` to JS at ~30 Hz). The
// generated Speakeasy-Swift.h declares that superclass, which the
// ObjC compiler can't resolve unless RCTEventEmitter.h is in scope
// BEFORE the Speakeasy-Swift.h import.
#import <React/RCTEventEmitter.h>
// Auto-generated header exposing the Speakeasy app target's Swift @objc
// declarations to ObjC. The "Speakeasy-Swift.h" name is derived from the
// product module name (PRODUCT_NAME).
#import "Speakeasy-Swift.h"
// Firebase: @react-native-firebase requires a configured default FIRApp
// before the JS bundle imports `@react-native-firebase/messaging`
// (index.js). Without `[FIRApp configure]` + a bundled GoogleService-Info
// .plist the app throws "No Firebase App '[DEFAULT]'" at startup and never
// renders. (Counterpart of Android's google-services.json + auto-init.)
#import <FirebaseCore/FirebaseCore.h>
// CallKit / VoIP push: PushKit wakes the app for an incoming call (even from
// a killed state); the AppDelegate must report it to CallKit (via RNCallKeep)
// inside the push handler BEFORE the completion handler, or iOS 13+ terminates
// the app and may stop delivering VoIP pushes. RNVoipPushNotificationManager
// (react-native-voip-push-notification) wraps PKPushRegistry + forwards the
// token/payload to JS; RNCallKeep (react-native-callkeep) drives the CallKit
// system call UI. The regular FCM/APNs banner path above is unchanged — VoIP
// pushes use a separate APNs topic (<bundleId>.voip) the server sends directly.
#import "RNVoipPushNotificationManager.h"
#import "RNCallKeep.h"

// Phase 5j Private Call: hook SpeakeasyAudioDevice into
// react-native-webrtc so EVERY call (audio / video / private)
// routes through our AVAudioEngine pipeline. The voice filter
// inside the device is toggled per-call via ActiveFilterHolder
// (set by VoiceFilterModule.wrapTrack / dispose). Without this
// install, react-native-webrtc constructs the stock C++ ADM and
// the JS shim's wrapTrack has no effect.
//
// WebRTCModuleOptions's header isn't exposed in the pod's umbrella
// module — react-native-webrtc.podspec doesn't set
// public_header_files. Forward-declare the minimal interface we
// need; the actual class is resolved dynamically at runtime by
// ObjC's class lookup.
@interface WebRTCModuleOptions : NSObject
+ (instancetype)sharedInstance;
@property(nonatomic, strong, nullable) id audioDevice;
// Keep the camera capturing while backgrounded into a PiP window (iOS
// Picture-in-Picture for video calls). Matches the real property in
// react-native-webrtc's WebRTCModuleOptions.h.
@property(nonatomic, assign) BOOL enableMultitaskingCameraAccess;
@end

// --- Crash capture --------------------------------------------------
// iOS counterpart of Android's MainApplication.kt `installCrashWriter`.
// `NSSetUncaughtExceptionHandler` catches uncaught NSExceptions —
// which includes React Native's fatal path (RCTFatal raises one). The
// report is written to a timestamped file in the app's Documents
// directory so a sideloaded alpha tester can retrieve it (via Xcode's
// device container). Native signal crashes (SIGSEGV/SIGABRT) are out
// of scope here — a full crash reporter is a follow-up (see
// apps/mobile/ios/HARDENING.md).
static void SpeakeasyWriteCrash(NSException *exception)
{
  @try {
    NSArray<NSString *> *dirs = NSSearchPathForDirectoriesInDomains(
        NSDocumentDirectory, NSUserDomainMask, YES);
    if (dirs.count == 0) { return; }

    NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
    fmt.dateFormat = @"yyyy-MM-dd'T'HH-mm-ss";
    NSString *ts = [fmt stringFromDate:[NSDate date]];
    NSString *path = [dirs[0] stringByAppendingPathComponent:
        [NSString stringWithFormat:@"speakeasy_crash_%@.txt", ts]];

    NSMutableString *report = [NSMutableString string];
    [report appendFormat:@"[crash @ %@]\n\n", ts];
    [report appendFormat:@"%@: %@\n\n", exception.name, exception.reason];
    [report appendString:
        [exception.callStackSymbols componentsJoinedByString:@"\n"]];

    [report writeToFile:path
             atomically:YES
               encoding:NSUTF8StringEncoding
                  error:NULL];
  } @catch (__unused NSException *ignored) {
    // Best effort — never let the reporter mask the original crash.
  }
}

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  // Install the crash handler before any other startup work, so a
  // crash during init (e.g. Vouchflow.configure) is still captured.
  NSSetUncaughtExceptionHandler(&SpeakeasyWriteCrash);

  // Configure Firebase before the RN bridge starts (the JS bundle imports
  // firebase messaging at load). Reads the bundled GoogleService-Info.plist.
  if ([FIRApp defaultApp] == nil) {
    [FIRApp configure];
  }

  self.moduleName = @"Speakeasy";
  // RN 0.77: required dependency provider for new-arch module setup.
  self.dependencyProvider = [RCTAppDependencyProvider new];
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  // Phase 5b iOS: Vouchflow SDK init. Per its README, configure() must be
  // called once at app startup before any other SDK method.
  //
  // Mirrors `MainApplication.kt onCreate` on Android. Reads the api key
  // and environment from gitignored Speakeasy/Vouchflow.plist (template
  // at Vouchflow.plist.example). The Swift `Vouchflow.configure` is
  // throws + takes a struct (no ObjC bridging) — we route through
  // SpeakeasyVouchflowBootstrap.
  NSString *plistPath = [[NSBundle mainBundle] pathForResource:@"Vouchflow" ofType:@"plist"];
  NSDictionary *vouchflowConfig = plistPath ? [NSDictionary dictionaryWithContentsOfFile:plistPath] : nil;
  NSString *vouchflowApiKey = vouchflowConfig[@"VouchflowApiKey"] ?: @"PLACEHOLDER_REPLACE_BEFORE_RUNNING";
  NSString *vouchflowEnv = vouchflowConfig[@"VouchflowEnvironment"] ?: @"sandbox";
  NSError *vouchflowErr = nil;
  [SpeakeasyVouchflowBootstrap configureWithApiKey:vouchflowApiKey
                                       environment:vouchflowEnv
                                             error:&vouchflowErr];
  if (vouchflowErr) {
    NSLog(@"Vouchflow.configure failed: %@", vouchflowErr.localizedDescription);
  }

  // Call audio: use react-native-webrtc's STOCK audio device on iOS.
  //
  // We previously installed a custom RTCAudioDevice (SpeakeasyAudioDevice, a
  // from-scratch AVAudioEngine pipeline) to power voice-masking + avatar
  // lip-sync. On real devices it never delivered working call audio — it
  // crashed on cold-launch accept, captured silence, and broke up playout
  // (iOS↔Android calls were unusable across builds 3–12, all directions),
  // while Android (stock audio path) worked fine. Real-time iOS audio can't
  // be debugged from the Linux dev box, so rather than keep shipping blind
  // guesses we fall back to the battle-tested stock ADM so calls actually
  // work. SpeakeasyAudioDevice stays in the tree; re-wire it here only once
  // its capture/playout are verified on a physical device (instrument first).
  //
  // Trade-off: voice-masking + avatar lip-sync are inactive on iOS calls
  // until then. They were 100% non-functional anyway (the engine they ride
  // on was broken), so this loses no working behavior — it restores calls.
  //
  //   WebRTCModuleOptions *rtcOptions = [WebRTCModuleOptions sharedInstance];
  //   rtcOptions.audioDevice = [[SpeakeasyAudioDevice alloc] init];

  // iOS Picture-in-Picture: allow the camera to keep running while the app is
  // backgrounded into a PiP window, so a video call doesn't freeze the local
  // feed the moment it floats. This is the documented react-native-webrtc PiP
  // prerequisite (GetStream/rn-webrtc recipe); it gracefully no-ops on devices
  // where the capture session reports it unsupported, so it's safe to set
  // unconditionally. The iOS-18 path is satisfied by the `voip` UIBackgroundMode
  // already in Info.plist (older iOS needs the multitasking-camera entitlement).
  [WebRTCModuleOptions sharedInstance].enableMultitaskingCameraAccess = YES;

  // CallKit / VoIP push: register the PKPushRegistry here, ASAP at launch —
  // doing it from JS can be too late to receive a VoIP push that woke the app.
  // The token is forwarded to JS via the `register` event and posted to the
  // server (voip_token), which sends incoming-call VoIP pushes to it directly.
  [RNVoipPushNotificationManager voipRegistration];

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

#pragma mark - PushKit (VoIP push) — CallKit incoming calls

// The VoIP push token changed — forward to JS (`register` event) so it can be
// posted to the server as the device's voip_token.
- (void)pushRegistry:(PKPushRegistry *)registry
    didUpdatePushCredentials:(PKPushCredentials *)credentials
                     forType:(PKPushType)type
{
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

// An incoming-call VoIP push arrived (possibly with the app killed). iOS 13+
// REQUIRES reporting it to CallKit before `completion()` or it terminates the
// app. We report immediately via RNCallKeep (native, no JS needed), then let
// JS finish wiring the call (connect WS, drain the buffered offer) — the
// callkeep `answerCall` event routes into the orchestrator (callkeep-bridge).
- (void)pushRegistry:(PKPushRegistry *)registry
    didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
                              forType:(PKPushType)type
                withCompletionHandler:(void (^)(void))completion
{
  NSDictionary *data = payload.dictionaryPayload;
  // call_id is the CallKit call UUID; the orchestrator keys the live call by
  // the same id so answerCall/endCall map back to the right call.
  NSString *uuid = data[@"call_id"] ?: [[NSUUID UUID] UUIDString];
  NSString *handle = data[@"handle"] ?: @"";
  NSString *callerName = data[@"caller_name"] ?: handle;
  BOOL hasVideo = [data[@"has_video"] boolValue];

  // Cache the completion handler so JS can signal completion once it has
  // started bringing up the call (onVoipNotificationCompleted).
  [RNVoipPushNotificationManager addCompletionHandler:uuid completionHandler:completion];

  // Forward the payload to JS (`notification` event).
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];

  // REQUIRED before completion(): report to CallKit so the system shows the
  // incoming-call UI and the app isn't terminated.
  [RNCallKeep reportNewIncomingCall:uuid
                             handle:handle
                         handleType:@"generic"
                           hasVideo:hasVideo
                localizedCallerName:callerName
                    supportsHolding:NO
                       supportsDTMF:NO
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:data
              withCompletionHandler:nil];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

// Custom-scheme deep links (speakeasy://add?handle=…).
- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

// Universal Links (https://speakeasyapp.xyz/add?handle=…). Requires the
// applinks:speakeasyapp.xyz Associated-Domains entitlement and the AASA file
// hosted at https://speakeasyapp.xyz/.well-known/apple-app-site-association.
- (BOOL)application:(UIApplication *)application
continueUserActivity:(nonnull NSUserActivity *)userActivity
 restorationHandler:(nonnull void (^)(NSArray<id<UIUserActivityRestoring>> *_Nullable))restorationHandler
{
  return [RCTLinkingManager application:application
                  continueUserActivity:userActivity
                    restorationHandler:restorationHandler];
}

@end
