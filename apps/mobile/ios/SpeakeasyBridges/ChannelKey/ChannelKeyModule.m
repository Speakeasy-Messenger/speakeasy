//
//  ChannelKeyModule.m
//  Speakeasy
//
//  ObjC registration. JS bridge name `ChannelKey` mirrors
//  Android's getName() = "ChannelKey".
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(ChannelKey, ChannelKeyModule, NSObject)

RCT_EXTERN_METHOD(generateChannelKey:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(wrapForRecipient:(NSString *)channelKey
                  recipientIdentityPub:(NSString *)recipientIdentityPub
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unwrapForSelf:(NSString *)wrapped
                  selfIdentityPriv:(NSString *)selfIdentityPriv
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(encryptMessage:(NSString *)channelKey
                  plaintext:(NSString *)plaintext
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(decryptMessage:(NSString *)channelKey
                  ciphertext:(NSString *)ciphertext
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
