//
//  VouchflowBootstrap.swift
//  Speakeasy
//
//  Tiny ObjC-callable wrapper around `VouchflowSDK.Vouchflow.configure(_:)`.
//  Required because `VouchflowConfig` is a Swift struct (value type) and
//  doesn't bridge to ObjC, so AppDelegate.mm can't construct one
//  directly. We expose a string-typed shim instead.
//
//  The SDK's August 2026 defaults still include an expired leaf pin. SDK 2.4.0
//  also checks pins before evaluating server trust, so a public intermediate
//  is not safe here. Pin the current production leaf in both SDK slots until
//  Vouchflow evaluates hostname/chain validity before its SPKI comparison.
//

import Foundation
import VouchflowSDK

@objc(SpeakeasyVouchflowBootstrap)
public final class SpeakeasyVouchflowBootstrap: NSObject {

    private static let productionLeafPin = "mX8Bi7dmXyNH4V/rjrvMcP1ZcxBzrnRmnNPnAvi1kTs="

    /// Called once from AppDelegate at app launch. Reads the api key and
    /// environment string out of the gitignored Speakeasy/Vouchflow.plist
    /// (template at Vouchflow.plist.example).
    ///
    /// Supplying the leaf in both slots prevents the SDK's OR comparison from
    /// accepting a public intermediate before normal server trust is checked.
    @objc public static func configure(apiKey: String, environment: String) throws {
        let env: VouchflowEnvironment = (environment == "sandbox") ? .sandbox : .production
        let cfg = VouchflowConfig(
            apiKey: apiKey,
            environment: env,
            keychainAccessGroup: nil,
            leafCertificatePin: productionLeafPin,
            intermediateCertificatePin: productionLeafPin
        )
        try Vouchflow.configure(cfg)
    }
}
