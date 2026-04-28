//
//  GroupMessagingModule.m
//  Speakeasy
//
//  ObjC registration. JS bridge name `GroupMessaging` mirrors Android.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(GroupMessaging, GroupMessagingModule, NSObject)


RCT_EXTERN_METHOD(createSenderKeyDistribution:(NSString *)distributionId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(processSenderKeyDistribution:(NSString *)senderUserId
                  skdmBytes:(NSString *)skdmBytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(encryptForGroup:(NSString *)distributionId
                  plaintext:(NSString *)plaintext
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(decryptFromGroupMember:(NSString *)senderUserId
                  ciphertext:(NSString *)ciphertext
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
