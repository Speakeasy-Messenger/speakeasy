#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
// Auto-generated header exposing the Speakeasy app target's Swift @objc
// declarations to ObjC. The "Speakeasy-Swift.h" name is derived from the
// product module name (PRODUCT_NAME).
#import "Speakeasy-Swift.h"

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
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
