//
//  VouchflowModule.m
//  Speakeasy
//
//  Objective-C registration for the Swift VouchflowModule. Required so
//  React Native's runtime can find the module via NativeModules.Vouchflow
//  on the JS side.
//
//  We use REMAP_MODULE because the Swift class is named `VouchflowModule`
//  (to avoid colliding with the imported `Vouchflow` SDK module name)
//  while the JS-visible name must be `Vouchflow` to match the Android
//  bridge (Android's `getName(): String = "Vouchflow"`).
//

#import <React/RCTBridgeModule.h>

// `requiresMainQueueSetup` is implemented on the Swift class with @objc;
// no ObjC redeclaration needed here (and one would be a syntax error
// inside a RCT_EXTERN_MODULE block).
@interface RCT_EXTERN_REMAP_MODULE(Vouchflow, VouchflowModule, NSObject)

RCT_EXTERN_METHOD(verify:(NSString *)context
                  minimumConfidence:(NSString *)minimumConfidence
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
