//
//  Speakeasy-Bridging-Header.h
//  Speakeasy
//
//  Bridging header that exposes React Native's Objective-C headers to our
//  Swift bridge modules. Reference this file in the project's
//  `SWIFT_OBJC_BRIDGING_HEADER` build setting (Xcode will prompt to create
//  one automatically the first time you add a Swift file to an ObjC
//  project; point it here).
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTConvert.h>
#import <React/RCTLog.h>

// SQLCipher exposes its sqlite3.h via CocoaPods. Pulling it in here
// makes every sqlite3_* C symbol visible to Swift (as Speakeasy module
// internals) without needing `import SQLCipher` in each Swift file —
// the pod doesn't ship a Swift modulemap.
#import <sqlite3.h>

// Phase 5j: SpeakeasyAudioDevice conforms to RTCAudioDevice from
// the JitsiWebRTC pod. The auto-generated Speakeasy-Swift.h needs
// to know the protocol declaration to compile cleanly; pulling
// WebRTC.h in here makes the protocol visible without each Swift
// file needing its own `import WebRTC`.
#import <WebRTC/WebRTC.h>
