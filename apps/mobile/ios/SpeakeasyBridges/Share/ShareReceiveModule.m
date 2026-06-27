//
//  ShareReceiveModule.m
//  Speakeasy
//
//  ObjC registration for the Swift ShareReceiveModule. JS bridge name
//  `SpeakeasyShare` mirrors the Android module.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(SpeakeasyShare, ShareReceiveModule, NSObject)

RCT_EXTERN_METHOD(consumePendingShare:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
