//
//  SpeakeasyDbModule.m
//  Speakeasy
//
//  ObjC registration for the Swift SpeakeasyDbModule. JS bridge name
//  `SpeakeasyDb` mirrors Android.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(SpeakeasyDb, SpeakeasyDbModule, NSObject)

RCT_EXTERN_METHOD(consumeResetFlag:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
