//
//  VouchflowBootstrap.swift
//  Speakeasy
//
//  Tiny ObjC-callable wrapper around `VouchflowSDK.Vouchflow.configure(_:)`.
//  Required because `VouchflowConfig` is a Swift struct (value type) and
//  doesn't bridge to ObjC, so AppDelegate.mm can't construct one
//  directly. We expose a string-typed shim instead.
//
//  SDK 2.0.0: `VouchflowConfig` now ships with correct default pin values
//  for the Let's Encrypt E7 intermediate. No need to pass empty/TODO
//  placeholders — the SDK's defaults are production-ready.
//

import Foundation
import VouchflowSDK

@objc(SpeakeasyVouchflowBootstrap)
public final class SpeakeasyVouchflowBootstrap: NSObject {

    /// Called once from AppDelegate at app launch. Reads the api key and
    /// environment string out of the gitignored Speakeasy/Vouchflow.plist
    /// (template at Vouchflow.plist.example).
    ///
    /// SDK 2.0.0: certificate pins use the SDK's built-in defaults (Let's
    /// Encrypt E7 intermediate). In debug builds the SDK warns if pins are
    /// placeholder strings; in release builds placeholder pins block all
    /// requests. We pass the real defaults through now.
    @objc public static func configure(apiKey: String, environment: String) throws {
        let env: VouchflowEnvironment = (environment == "sandbox") ? .sandbox : .production
        let cfg = VouchflowConfig(
            apiKey: apiKey,
            environment: env,
            keychainAccessGroup: nil
        )
        try Vouchflow.configure(cfg)
    }
}
