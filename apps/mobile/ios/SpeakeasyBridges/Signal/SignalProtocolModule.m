//
//  SignalProtocolModule.m
//  Speakeasy
//
//  ObjC registration. JS bridge name `SignalProtocol` mirrors Android.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(SignalProtocol, SignalProtocolModule, NSObject)


RCT_EXTERN_METHOD(generateIdentityKey:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(generatePreKeyBundle:(nonnull NSNumber *)registrationId
                  signedPreKeyId:(nonnull NSNumber *)signedPreKeyId
                  oneTimePreKeyCount:(nonnull NSNumber *)oneTimePreKeyCount
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(initiateSession:(NSString *)peerUserId
                  peerBundle:(NSDictionary *)peerBundle
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(encrypt:(NSString *)peerUserId
                  plaintext:(NSString *)plaintext
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(decrypt:(NSString *)peerUserId
                  ciphertext:(NSString *)ciphertext
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
