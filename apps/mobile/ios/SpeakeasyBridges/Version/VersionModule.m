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

@interface RCT_EXTERN_REMAP_MODULE(SpeakeasyVersion, VersionModule, NSObject)

@end
