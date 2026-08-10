#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <AVFAudio/AVFAudio.h>
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

  // iOS Keychain items outlive app deletion, so a reinstall used to
  // inherit the Vouchflow device token (and DB root secret) while the
  // app container — including the Signal store — was gone: the account
  // resumed with a BRAND-NEW identity, bypassing enroll/rebind, and
  // every peer saw "[identity changed]". Purge surviving credentials on
  // a genuine fresh install so reinstall means re-onboard (the policy
  // Android's backup_rules.xml already documents). Must run before
  // Vouchflow.configure or any DB open touches the Keychain.
  [FreshInstallGuard runAtLaunch];

  // Configure Firebase before the RN bridge starts (the JS bundle imports
  // firebase messaging at load). Reads the bundled GoogleService-Info.plist.
  if ([FIRApp defaultApp] == nil) {
    [FIRApp configure];
  }

  self.moduleName = @"Speakeasy";
  // RN 0.77: required dependency provider for new-arch module setup.
  self.dependencyProvider = [RCTAppDependencyProvider new];
  // BrowserStack's signed real-device build compiles this one flag into the
  // native launcher. Production/TestFlight builds never define it and always
  // boot the real app. Keeping the switch native prevents a URL or JS setting
  // from exposing the standalone camera/PiP harness to users.
#if SPEAKEASY_VIDEO_CALL_HARNESS
  self.initialProps = @{@"videoCallHarness": @YES};
#else
  self.initialProps = @{};
#endif

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
  // unconditionally. The matching `voip` background mode and multitasking-
  // camera entitlement are declared in Info.plist / Speakeasy.entitlements.
  [WebRTCModuleOptions sharedInstance].enableMultitaskingCameraAccess = YES;

  // Configure CallKit natively before registering PushKit. A VoIP push can
  // launch a killed app before React Native exists; reportNewIncomingCall must
  // already have a CXProvider or iOS terminates the process for an unhandled
  // VoIP push. JS setup is intentionally allowed to become a no-op after this.
  [RNCallKeep setup:@{
    @"appName": @"Speakeasy",
    @"includesCallsInRecents": @NO,
    @"supportsVideo": @YES,
    @"maximumCallGroups": @1,
    @"maximumCallsPerCallGroup": @1,
    // VideoChat keeps AVKit PiP eligible. CallKit remains the only owner that
    // activates/deactivates this session; WebRTC follows its delegate events.
    @"audioSession": @{
      @"categoryOptions": @(AVAudioSessionCategoryOptionAllowBluetooth |
                              AVAudioSessionCategoryOptionAllowBluetoothA2DP),
      @"mode": AVAudioSessionModeVideoChat,
    },
  }];
  [RNVoipPushNotificationManager voipRegistration];

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

#pragma mark - PushKit / CallKit

- (void)pushRegistry:(PKPushRegistry *)registry
    didUpdatePushCredentials:(PKPushCredentials *)credentials
                     forType:(PKPushType)type
{
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials
                                                   forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry
    didInvalidatePushTokenForType:(PKPushType)type
{
  NSLog(@"PushKit token invalidated for type %@", type);
}

- (void)pushRegistry:(PKPushRegistry *)registry
    didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
                              forType:(PKPushType)type
                withCompletionHandler:(void (^)(void))completion
{
  NSMutableDictionary *data = [payload.dictionaryPayload mutableCopy] ?: [NSMutableDictionary dictionary];
  NSString *uuid = data[@"call_uuid"];
  if (uuid.length == 0 || [[NSUUID alloc] initWithUUIDString:uuid] == nil) {
    uuid = [[NSUUID UUID] UUIDString];
    data[@"call_uuid"] = uuid;
  }
  NSString *handle = data[@"handle"] ?: @"unknown";
  NSString *callerName = data[@"caller_name"] ?: handle;
  BOOL hasVideo = [data[@"has_video"] boolValue];

  // Preserve the payload for JS so it can warm the websocket and bind our
  // call_id to the native CallKit UUID. CallKit reporting itself is native and
  // happens immediately, including on a killed-app launch.
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload
                                                            forType:(NSString *)type];
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
              withCompletionHandler:completion];
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
