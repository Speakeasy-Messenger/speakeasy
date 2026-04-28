//
//  VouchflowBootstrap.swift
//  Speakeasy
//
//  Tiny ObjC-callable wrapper around `VouchflowSDK.Vouchflow.configure(_:)`.
//  Required because `VouchflowConfig` is a Swift struct (value type) and
//  doesn't bridge to ObjC, so AppDelegate.mm can't construct one
//  directly. We expose a string-typed shim instead.
//

import Foundation
import VouchflowSDK

@objc(SpeakeasyVouchflowBootstrap)
public final class SpeakeasyVouchflowBootstrap: NSObject {

    /// Called once from AppDelegate at app launch. Reads the api key and
    /// environment string out of the gitignored Speakeasy/Vouchflow.plist
    /// (template at Vouchflow.plist.example).
    ///
    /// Pin params are placeholders — the SDK warns at runtime in DEBUG
    /// builds and disables certificate pinning. In release builds the
    /// real pins must be supplied here (TODO: ship per-environment pins
    /// alongside the api key).
    @objc public static func configure(apiKey: String, environment: String) throws {
        let env: VouchflowEnvironment = (environment == "sandbox") ? .sandbox : .production
        let cfg = VouchflowConfig(
            apiKey: apiKey,
            environment: env,
            keychainAccessGroup: nil,
            leafCertificatePin: "",
            intermediateCertificatePin: ""
        )
        try Vouchflow.configure(cfg)
    }
}
