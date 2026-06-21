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

// The Swift class implements all four @objc methods, but only methods
// declared via RCT_EXTERN_METHOD here are visible on NativeModules.Vouchflow.
// Without these three the email-OTP attestation fallback path (requestFallback
// → submitFallbackOtp) and the cached-token read are unreachable from JS on
// iOS, breaking parity with Android's VouchflowModule.kt. Selectors mirror the
// @objc signatures in VouchflowModule.swift exactly.
RCT_EXTERN_METHOD(requestFallback:(NSString *)email
                  reason:(NSString *)reason
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(submitFallbackOtp:(NSString *)sessionId
                  otp:(NSString *)otp
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getCachedDeviceToken:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
