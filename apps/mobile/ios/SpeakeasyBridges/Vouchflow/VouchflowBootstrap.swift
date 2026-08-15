//
//  VouchflowBootstrap.swift
//  Speakeasy
//
//  Tiny ObjC-callable wrapper around `VouchflowSDK.Vouchflow.configure(_:)`.
//  Required because `VouchflowConfig` is a Swift struct (value type) and
//  doesn't bridge to ObjC, so AppDelegate.mm can't construct one
//  directly. We expose a string-typed shim instead.
//
//  The SDK's August 2026 defaults still include an expired leaf pin.  We pin
//  both Let's Encrypt issuing intermediates used by api.vouchflow.dev instead,
//  which keeps pinning enforced across leaf and YE1/YE2 rotations.
//

import Foundation
import VouchflowSDK

@objc(SpeakeasyVouchflowBootstrap)
public final class SpeakeasyVouchflowBootstrap: NSObject {

    private static let letsEncryptYE1Pin = "brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4="
    private static let letsEncryptYE2Pin = "s/tdAOmUzd8syaTuqfgGvFcn6DzA5Cmb+Vby1ST+U3Y="

    /// Called once from AppDelegate at app launch. Reads the api key and
    /// environment string out of the gitignored Speakeasy/Vouchflow.plist
    /// (template at Vouchflow.plist.example).
    ///
    /// The property names are historical. Vouchflow checks both configured
    /// values against every certificate in the valid server chain, so these
    /// are the YE1 and YE2 intermediate SPKI hashes rather than a leaf hash.
    @objc public static func configure(apiKey: String, environment: String) throws {
        let env: VouchflowEnvironment = (environment == "sandbox") ? .sandbox : .production
        let cfg = VouchflowConfig(
            apiKey: apiKey,
            environment: env,
            keychainAccessGroup: nil,
            leafCertificatePin: letsEncryptYE2Pin,
            intermediateCertificatePin: letsEncryptYE1Pin
        )
        try Vouchflow.configure(cfg)
    }
}
