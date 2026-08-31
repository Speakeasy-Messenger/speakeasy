//
//  VersionModule.m
//  Speakeasy
//
//  ObjC registration for the Swift VersionModule. The JS-visible name
//  is `SpeakeasyVersion` (mirrors Android's getName() = "SpeakeasyVersion");
//  the Swift class is `VersionModule`, hence RCT_EXTERN_REMAP_MODULE.
//
//  constantsToExport / requiresMainQueueSetup are implemented on the
//  Swift class with @objc — no ObjC redeclaration needed (and one
//  would be a syntax error inside an RCT_EXTERN_MODULE block).
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_REMAP_MODULE(SpeakeasyVersion, VersionModule, NSObject)

@end

@interface RCT_EXTERN_REMAP_MODULE(SpeakeasyNativeDiagnostics, NativeDiagnosticsModule, RCTEventEmitter)

RCT_EXTERN_METHOD(consumePendingPipClose:(NSString *)sessionId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setPipSession:(NSString * _Nullable)sessionId)
RCT_EXTERN_METHOD(drainNativeDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(consumePendingCallKitReports:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
