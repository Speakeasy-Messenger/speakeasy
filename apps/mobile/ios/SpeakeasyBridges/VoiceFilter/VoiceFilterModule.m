//
//  VoiceFilterModule.m
//  Speakeasy
//
//  ObjC registration for the Swift VoiceFilterModule. The JS-visible
//  name is `SpeakeasyVoiceFilter` (mirrors Android's getName() =
//  "SpeakeasyVoiceFilter"); the Swift class is `VoiceFilterModule`,
//  hence RCT_EXTERN_REMAP_MODULE.
//
//  constantsToExport / requiresMainQueueSetup are implemented on the
//  Swift class with @objc — no ObjC redeclaration needed (and one
//  would be a syntax error inside an RCT_EXTERN_MODULE block).
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Phase 5j PR-G — VoiceFilterModule extends RCTEventEmitter (not
// NSObject) so it can emit `SpeakeasyVoiceFilterFeatures` to JS at
// ~30 Hz while a Private Call is active. The third arg below must
// match the Swift base class.
@interface RCT_EXTERN_REMAP_MODULE(SpeakeasyVoiceFilter, VoiceFilterModule, RCTEventEmitter)

RCT_EXTERN_METHOD(wrapTrack:(NSString *)trackId
                  semitones:(nullable NSNumber *)semitones
                  formantSemitones:(nullable NSNumber *)formantSemitones
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(dispose:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
