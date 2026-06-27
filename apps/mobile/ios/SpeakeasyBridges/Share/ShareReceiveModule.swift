//
//  ShareReceiveModule.swift
//  Speakeasy
//
//  Reads text shared into the app by the ShareExtension (which writes it to
//  the App Group container), then clears it. JS bridge name `SpeakeasyShare`
//  mirrors the Android module, so consumePendingShare() works cross-platform.
//

import Foundation

@objc(ShareReceiveModule)
final class ShareReceiveModule: NSObject {

  private static let appGroup = "group.xyz.speakeasyapp.app"
  private static let key = "pendingShareText"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(consumePendingShare:rejecter:)
  func consumePendingShare(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let defaults = UserDefaults(suiteName: ShareReceiveModule.appGroup)
    let text = defaults?.string(forKey: ShareReceiveModule.key)
    if text != nil {
      defaults?.removeObject(forKey: ShareReceiveModule.key)
    }
    if let value = text, !value.isEmpty {
      resolve(["text": value])
    } else {
      resolve(nil)
    }
  }
}
