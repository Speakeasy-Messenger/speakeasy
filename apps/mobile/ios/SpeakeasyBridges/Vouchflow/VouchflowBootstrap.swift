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
    // Pin the two ISRG **roots** (Let's Encrypt's parent CAs), never the
    // leaf and never an issuing intermediate. These mirror Android exactly
    // (`MainApplication.kt`, VOUCHFLOW_ISRG_ROOT_X2_PIN / _X1_PIN); the
    // parity — and the pin values themselves — are asserted by
    // `apps/mobile/src/integration/vouchflow-pin-rotation.test.ts`, which
    // recomputes both pins from the checked-in root fixtures
    // (`src/integration/fixtures/isrg-root-{x1,x2}.pem`) and fails CI if
    // the two platforms ever drift apart or a hash is mistyped.
    //
    // ## Why the roots and not the leaf
    //
    // `api.vouchflow.dev` is served from Fly.io with a ~90-day Let's Encrypt
    // leaf that is renewed ~30 days before expiry. Pinning that leaf makes
    // every already-shipped build stop working on rotation day: the SDK
    // raises `pinningFailure`, `VouchflowModule.swift` maps it to
    // `network_unavailable`, `verify()` then fails before it can even create
    // a session, and the user is parked in an unrecoverable "Verify this
    // device" loop that no retry and no email fallback can clear. That
    // actually happened — PR #204 (`352ba1a`, 2026-08-14) was the reactive
    // patch for the 2026-08-10 leaf rotation.
    //
    // ## Why not the issuing intermediates either
    //
    // From 2026-08-14 the two slots held Let's Encrypt's ECDSA issuing
    // intermediates (YE1 + YE2). That survived leaf rotation, but on
    // 2026-09-06 Let's Encrypt rotated its issuing intermediate from YE1 to
    // YE2, YE1 left the served chain, and every build that still carried the
    // YE1 pin had no spare — production sign-in broke for all users until an
    // emergency release (and an Apple review) went out. Intermediates rotate
    // a few times a year, and pinning them buys almost no security over
    // pinning the root: any certificate that authority issues to *anyone*
    // carries the same intermediate, so an attacker holding a fraudulently
    // issued certificate for our hostname would pass an intermediate pin
    // exactly as it passes a root pin. Captain's decision (2026-09-06):
    // pin the roots.
    //
    // The roots rotate on the order of a decade, not months:
    //
    //   * ISRG Root X2 — EC P-384, expires 2040-09-17. The trust anchor of
    //     the chain `api.vouchflow.dev` serves today (leaf EC P-256 → YE2 →
    //     Root YE → ISRG Root X2).
    //   * ISRG Root X1 — RSA 4096, expires 2035-06-04. The RSA-chain anchor;
    //     kept in the second slot so an RSA chain — or a switch back to one —
    //     still validates. On devices whose trust store lacks X2, evaluation
    //     anchors at X1 via the X2 cross-sign that the server serves.
    //
    // ## What the SDK actually compares these against
    //
    // Verified against vouchflow/ios-sdk **v2.5.0** — the exact version
    // pinned in `Speakeasy.xcodeproj/project.pbxproj` — not assumed from the
    // parameter names:
    //
    //   * `PinningDelegate` validates *first*, then pins. It binds an
    //     `SecPolicyCreateSSL` policy to the expected host and requires
    //     `SecTrustEvaluateWithError` to pass — expiry, revocation,
    //     chain-to-a-trusted-root and hostname are all checked by the OS —
    //     and only then compares SPKI pins as an **additional** constraint.
    //     This is the property that makes root pinning acceptable: a root
    //     pin alone constrains nothing (the OS already requires chaining to
    //     a trusted root), so hostname validation must not be skippable.
    //   * Pin comparison walks *every* certificate in the evaluated chain —
    //     leaf, intermediates, and the trusted anchor — and accepts on the
    //     first SPKI-SHA256 match against **either** configured pin (OR
    //     semantics). Neither slot is position-checked, so the parameter
    //     names `leafCertificatePin` / `intermediateCertificatePin` are
    //     historical labels only: these two constants are both ROOT
    //     anchors, not leaf/intermediate values.
    //   * SDK >= 2.2.0 branches its ASN.1 SPKI header on the certificate's
    //     actual curve. ISRG Root X2 is EC P-384; before 2.2.0 the SDK
    //     hardcoded the P-256 header and a P-384 pin could therefore *never*
    //     match.
    //   * The values must be raw base64 (no `sha256/` prefix); the SDK
    //     `precondition`s on that at configure() time.
    //
    // ## Why v2.5.0 is not separable from these pin values
    //
    // Do **not** downgrade the SPM pin below 2.5.0 while these constants are
    // in place. Up to and including v2.4.0 the SDK never called
    // `SecTrustEvaluateWithError`: a pin match short-circuited straight to
    // `.useCredential`, replacing the system's chain/hostname evaluation
    // rather than adding to it. With ROOT pins that is maximally dangerous —
    // a root pin without prior OS validation accepts *any* certificate that
    // chains to that root, for any hostname, i.e. effectively any
    // Let's Encrypt certificate ever issued. 2.5.0 (`972fe82`, "validate TLS
    // before certificate pinning") makes the OS check run first, and
    // `vouchflow-pin-rotation.test.ts` asserts the floor so a downgrade
    // fails CI rather than silently reopening the hole.
    //
    // (Android was never exposed to this: OkHttp's CertificatePinner runs
    // *after* the platform trust manager validates chain and hostname, which
    // is why root pins are equally safe there.)

    /// ISRG Root X2 (EC P-384, expires 2040-09-17): the trust anchor of the
    /// chain `api.vouchflow.dev` serves today.
    private static let isrgRootX2Pin = "diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI="

    /// ISRG Root X1 (RSA 4096, expires 2035-06-04): the RSA-chain anchor, so
    /// an RSA chain or a switch back to one still validates.
    private static let isrgRootX1Pin = "C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M="

    /// Called once from AppDelegate at app launch. Reads the api key and
    /// environment string out of the gitignored Speakeasy/Vouchflow.plist
    /// (template at Vouchflow.plist.example).
    ///
    /// Slot assignment mirrors Android so the two platforms diff cleanly; the
    /// SDK treats the two slots identically (see the note above) — both hold
    /// root pins here.
    @objc public static func configure(apiKey: String, environment: String) throws {
        let env: VouchflowEnvironment = (environment == "sandbox") ? .sandbox : .production
        let cfg = VouchflowConfig(
            apiKey: apiKey,
            environment: env,
            keychainAccessGroup: nil,
            leafCertificatePin: isrgRootX2Pin,
            intermediateCertificatePin: isrgRootX1Pin
        )
        try Vouchflow.configure(cfg)
    }
}
