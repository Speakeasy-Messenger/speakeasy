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

    // MARK: - Certificate pins
    //
    // Pin the two Let's Encrypt *issuing intermediates*, never the leaf.
    // These mirror Android exactly (`MainApplication.kt`,
    // VOUCHFLOW_LETS_ENCRYPT_YE1_PIN / _YE2_PIN); the parity is asserted by
    // `apps/mobile/src/integration/vouchflow-pin-rotation.test.ts`, which
    // fails CI if the two platforms ever drift apart again.
    //
    // ## Why not the leaf
    //
    // `api.vouchflow.dev` is served from Fly.io with a ~90-day Let's Encrypt
    // leaf that is renewed ~30 days before expiry. Pinning that leaf makes
    // every already-shipped build stop working on rotation day: the SDK
    // raises `pinningFailure`, `VouchflowModule.swift` maps it to
    // `network_unavailable`, `verify()` then fails before it can even create
    // a session, and the user is parked in an unrecoverable "Verify this
    // device" loop that no retry and no email fallback can clear. That has
    // already fired once — PR #204 (`352ba1a`, 2026-08-14) was the reactive
    // patch for the 2026-08-10 rotation. The intermediates are valid until
    // 2028-09-02, so pinning them decouples app availability from the leaf.
    //
    // ## What the SDK actually compares these against
    //
    // Verified against vouchflow/ios-sdk **v2.4.0** — the exact version
    // pinned in `Speakeasy.xcodeproj/project.pbxproj` — not assumed from the
    // parameter names:
    //
    //   * `PinningDelegate.urlSession(_:didReceive:completionHandler:)` walks
    //     *every* certificate in the served chain and accepts the connection
    //     on the first SPKI-SHA256 match against **either** configured pin
    //     (OR semantics). Neither slot is position-checked, so the names
    //     `leafCertificatePin` / `intermediateCertificatePin` are historical
    //     labels only: an intermediate SPKI in the "leaf" slot is valid and
    //     is what the SDK's own defaults ship.
    //   * SDK >= 2.2.0 branches its ASN.1 SPKI header on the certificate's
    //     actual curve. Both YE1 and YE2 are EC P-384; before 2.2.0 the SDK
    //     hardcoded the P-256 header and an intermediate pin could therefore
    //     *never* match. We are on 2.4.0, so this is safe — but do not
    //     downgrade the SPM pin below 2.2.0 without moving back to a leaf pin.
    //   * The values must be raw base64 (no `sha256/` prefix); the SDK
    //     `precondition`s on that at configure() time.
    //
    // ## Known residual risk (deliberate, not an oversight)
    //
    // v2.4.0's `PinningDelegate` never calls `SecTrustEvaluateWithError`: a
    // pin match short-circuits straight to `.useCredential`, which replaces
    // the system's chain/hostname evaluation rather than adding to it. With a
    // *public* CA in the pin set, a network attacker holding any certificate
    // issued by YE1/YE2 — for any hostname, obtainable free in minutes —
    // would be accepted. Android is not exposed to this: OkHttp's
    // CertificatePinner runs *after* the platform trust manager has already
    // validated chain and hostname, which is why the same two constants give
    // a stronger posture there.
    //
    // This trade-off was taken knowingly (captain decision hold
    // `speakeasy-verify-loop-diagnosis-decision-ios-cert-pin-strategy`): the
    // alternative, leaf pinning, is a *guaranteed* total iOS outage every
    // ~90 days, and this attack additionally requires active network
    // interception. The durable fix belongs in the SDK — evaluate hostname
    // and chain validity first, then apply the SPKI comparison as an extra
    // constraint (Apple TN3126). Once an ios-sdk release does that, this
    // comment and the risk go away with no change to the pins below.

    /// Let's Encrypt YE1 issuing intermediate (EC P-384). Kept alongside YE2
    /// so an issuer rollover is already covered without an app update.
    private static let letsEncryptYE1Pin = "brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4="

    /// Let's Encrypt YE2 issuing intermediate (EC P-384), valid
    /// 2025-09-03 → 2028-09-02. Currently issues the `api.vouchflow.dev` leaf.
    private static let letsEncryptYE2Pin = "s/tdAOmUzd8syaTuqfgGvFcn6DzA5Cmb+Vby1ST+U3Y="

    /// Called once from AppDelegate at app launch. Reads the api key and
    /// environment string out of the gitignored Speakeasy/Vouchflow.plist
    /// (template at Vouchflow.plist.example).
    ///
    /// Slot assignment mirrors Android so the two platforms diff cleanly; the
    /// SDK treats the two slots identically (see the note above).
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
