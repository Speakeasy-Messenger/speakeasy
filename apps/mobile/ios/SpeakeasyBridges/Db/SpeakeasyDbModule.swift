//
//  SpeakeasyDbModule.swift
//  Speakeasy
//
//  RN bridge for the small bit of SpeakeasyDb state JS needs to
//  observe. Mirrors apps/mobile/android/.../db/SpeakeasyDbModule.kt —
//  same JS bridge name (`SpeakeasyDb`), same one-method shape.
//
//  Currently exposes one method: consumeResetFlag. The native DB layer
//  sets a one-shot "the local store was reset" flag whenever it
//  deletes the encrypted file outside of a user-initiated wipe —
//  either the upgrade-time orphan cleanup or the lost-key recovery
//  branch. JS reads-and-clears that flag at startup and surfaces a
//  banner / diag entry to the user, so a wipe is never silent.
//

import Foundation

@objc(SpeakeasyDbModule)
final class SpeakeasyDbModule: NSObject {

    @objc static func requiresMainQueueSetup() -> Bool { false }

    @objc(consumeResetFlag:rejecter:)
    func consumeResetFlag(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(SpeakeasyDb.shared.consumeResetFlag())
    }
}
