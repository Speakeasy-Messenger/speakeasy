#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
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

  // Phase 5j Private Call: install our custom RTCAudioDevice BEFORE
  // the React Native bridge initializes (which constructs the
  // WebRTCModule, which reads WebRTCModuleOptions). Once set,
  // every PeerConnectionFactory created by react-native-webrtc
  // uses our SpeakeasyAudioDevice for capture + playback.
  WebRTCModuleOptions *rtcOptions = [WebRTCModuleOptions sharedInstance];
  rtcOptions.audioDevice = [[SpeakeasyAudioDevice alloc] init];

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
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

@end
