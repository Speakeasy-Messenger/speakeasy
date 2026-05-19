# Speakeasy R8 / ProGuard keep rules for release (minified) builds.
#
# Most React Native community libraries ship their own consumer rules
# inside their AARs, which R8 applies automatically. The rules below
# cover the surfaces R8 *cannot* see through on its own: the JS<->native
# bridge (invoked reflectively), this app's own native modules (no
# consumer rules — they are application code), and the JNI-backed
# crypto / storage / attestation SDKs.
#
# Validate after any change here by building a minified release APK and
# exercising it — a missing keep surfaces as a runtime ClassNotFound /
# NoSuchMethod, not a build error.

# ── React Native bridge ──────────────────────────────────────────────
# RN's own consumer rules have lagged the new architecture before; keep
# the reflective bridge surfaces explicitly so a renamed @ReactMethod
# cannot surface as a runtime "method not found" from JS.
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod *;
}
-keep @com.facebook.react.module.annotations.ReactModule class * { *; }
-keep class * extends com.facebook.react.bridge.ReactContextBaseJavaModule { *; }
-keep class * extends com.facebook.react.bridge.NativeModule { *; }
-keep class * implements com.facebook.react.ReactPackage { *; }
-keepclassmembers class * {
    @com.facebook.react.uimanager.annotations.ReactProp <methods>;
}

# ── Speakeasy native modules ─────────────────────────────────────────
# This app's Kotlin bridges — Vouchflow, SecureKv, the Signal store, the
# SQLCipher DB, Channel Key, version. They have no consumer rules (they
# are application code) and their @ReactMethod members are called
# reflectively from JS. The app's own bytecode is tiny next to RN +
# libsignal, so keeping it wholesale costs almost nothing in shrink.
-keep class xyz.speakeasyapp.app.** { *; }

# ── JNI-backed native libraries ──────────────────────────────────────
# Any class with native methods must keep those members' names so the
# JNI symbol lookup resolves.
-keepclasseswithmembernames class * {
    native <methods>;
}
# Signal Protocol — Rust core reached over JNI.
-keep class org.signal.libsignal.** { *; }
-dontwarn org.signal.libsignal.**
# SQLCipher for Android — native lib loaded via System.loadLibrary.
-keep class net.zetetic.** { *; }
-dontwarn net.zetetic.**
# Vouchflow SDK — Android Keystore / AccountManager / Play Integrity /
# biometrics, plus the models its API (de)serialises. Kept wholesale.
-keep class dev.vouchflow.** { *; }
-dontwarn dev.vouchflow.**
