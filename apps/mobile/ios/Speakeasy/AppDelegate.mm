#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
// Auto-generated header exposing the Speakeasy app target's Swift @objc
// declarations to ObjC. The "Speakeasy-Swift.h" name is derived from the
// product module name (PRODUCT_NAME).
#import "Speakeasy-Swift.h"

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
