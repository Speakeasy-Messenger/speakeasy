#import <RCTAppDelegate.h>
#import <UIKit/UIKit.h>
// PushKit (VoIP push) — the AppDelegate is the PKPushRegistry delegate so an
// incoming-call VoIP push can wake the app from a killed/background state and
// report to CallKit BEFORE the completion handler (iOS 13+ requirement).
#import <PushKit/PushKit.h>

@interface AppDelegate : RCTAppDelegate <PKPushRegistryDelegate>

@end
