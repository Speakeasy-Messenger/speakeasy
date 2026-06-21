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

RCT_EXTERN_METHOD(hasSession:(NSString *)peerUserId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Parity with Android SignalProtocolModule.kt (8 @ReactMethods). Without
// these two the shared NativeSignalProtocolModule contract is unmet on iOS:
// resetPeer backs the "[couldn't decrypt] → reset" recovery (ChatScreen) and
// wipeStore backs account deletion. Selectors mirror the @objc signatures in
// SignalProtocolModule.swift.
RCT_EXTERN_METHOD(resetPeer:(NSString *)peerUserId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(wipeStore:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
