package xyz.speakeasyapp.app

import android.app.Application
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import xyz.speakeasyapp.app.channelkey.ChannelKeyPackage
import xyz.speakeasyapp.app.fileopener.FileOpenerPackage
import xyz.speakeasyapp.app.lockscreen.LockScreenPackage
import xyz.speakeasyapp.app.notif.NotifMessagingPackage
import xyz.speakeasyapp.app.signal.SignalProtocolPackage
import xyz.speakeasyapp.app.version.VersionPackage
import xyz.speakeasyapp.app.voicefilter.VoiceFilterPackage
import xyz.speakeasyapp.app.vouchflow.VouchflowPackage
import dev.vouchflow.sdk.Vouchflow
import dev.vouchflow.sdk.VouchflowConfig
import dev.vouchflow.sdk.VouchflowEnvironment

// SPKI SHA-256 pins for the production Vouchflow API (api.vouchflow.dev).
// See the configure() call below for why these exist and the rotation
// caveat. Public values (cert hashes), safe to commit.
//
// FORMAT: RAW base64 of the SPKI SHA-256 — NO `sha256/` prefix. The SDK's
// PinningInterceptor builds the OkHttp pin as `"sha256/${leafCertificatePin}"`,
// i.e. it prepends `sha256/` itself. v1.0.5 shipped these WITH the prefix,
// producing a double `sha256/sha256/...` pin that never matched → the SDK
// fell back / rejected and verify() failed with PinningFailure. Verified
// against dev.vouchflow:android-sdk:2.1.1 (PinningInterceptor.kt:53-54).
//   leaf         CN=vouchflow.dev    (SAN *.vouchflow.dev)
//   intermediate Let's Encrypt YE1
private const val VOUCHFLOW_PROD_LEAF_PIN =
    "NQ7reZqY0tQjef9LBQwbs0gHjrdrroWrd+scM74zQrU="
private const val VOUCHFLOW_PROD_INTERMEDIATE_PIN =
    "brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4="

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Phase 5b: hand-registered (local modules, not autolinked).
              add(VouchflowPackage())
              add(SignalProtocolPackage())
              add(ChannelKeyPackage())
              add(VersionPackage())
              add(FileOpenerPackage())
              add(LockScreenPackage())
              add(NotifMessagingPackage())
              add(VoiceFilterPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    installCrashWriter()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    // Phase 5b: Vouchflow SDK init. Per its README, configure() must be
    // called once at app startup before any other SDK method.
    //
    // BuildConfig fields come from android/gradle.properties (gitignored
    // for the API key — see android/gradle.properties.example).
    //
    // Certificate pinning (v1.0.5 fix): the SDK enforces TLS pinning in
    // PRODUCTION. v1.0.4 shipped WITHOUT real pins, so the SDK fell back to
    // placeholder pins and every verify() failed client-side with
    // `VouchflowError$PinningFailure` — blocking ALL production signups
    // (sandbox relaxes pinning, which is why the alpha never hit it). The
    // pins below are the SPKI SHA-256 of the production cert chain for
    // api.vouchflow.dev (SAN *.vouchflow.dev): the leaf (CN=vouchflow.dev)
    // and the Let's Encrypt intermediate (YE1). Set only for production;
    // sandbox uses the SDK default (no enforced pin).
    //
    // ⚠ Rotation: api.vouchflow.dev is Let's Encrypt, so the LEAF rotates
    // ~every 60 days. Pinning the intermediate as well keeps verify()
    // working across a leaf renewal; if Let's Encrypt rotates the YE1
    // intermediate these must be refreshed (recompute from the live chain:
    //   openssl s_client -connect api.vouchflow.dev:443 -showcerts).
    val isSandbox = BuildConfig.VOUCHFLOW_ENVIRONMENT == "sandbox"
    val vouchflowConfig =
        if (isSandbox)
            VouchflowConfig(
                apiKey = BuildConfig.VOUCHFLOW_API_KEY,
                environment = VouchflowEnvironment.SANDBOX,
            )
        else
            VouchflowConfig(
                apiKey = BuildConfig.VOUCHFLOW_API_KEY,
                environment = VouchflowEnvironment.PRODUCTION,
                leafCertificatePin = VOUCHFLOW_PROD_LEAF_PIN,
                intermediateCertificatePin = VOUCHFLOW_PROD_INTERMEDIATE_PIN,
            )
    Vouchflow.configure(vouchflowConfig)
  }

  /**
   * Install a default uncaught-exception handler that writes the stack
   * trace to `/sdcard/Download/speakeasy_last_crash.txt` so the alpha
   * tester (sideloaded, no logcat, no PC) can `cat` it from Termux.
   *
   * Inlined here on purpose — no separate class, no React types — so we
   * don't trigger any class loading before SoLoader.init(). MediaStore
   * Downloads is the only path Termux can read on Android 11+ without
   * SAF acrobatics or root (the `Android/data/<pkg>` dir is restricted).
   */
  private fun installCrashWriter() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    val ctx = applicationContext
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        val sw = StringWriter()
        PrintWriter(sw).use { throwable.printStackTrace(it) }
        val report = buildString {
          append("[crash @ ")
          append(java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(java.util.Date()))
          append("] thread=").append(thread.name).append("\n\n")
          append(sw.toString())
        }
        // Timestamp in the filename so MediaStore doesn't suffix
        // duplicates with `(1)`/`(2)`/... — every crash gets its own
        // file and the user can `ls -t /sdcard/Download/speakeasy_crash_*`
        // to find the latest.
        val ts = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss").format(java.util.Date())
        val filename = "speakeasy_crash_$ts.txt"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val values =
              ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
              }
          val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          if (uri != null) {
            ctx.contentResolver.openOutputStream(uri).use { it?.write(report.toByteArray()) }
          }
        } else {
          @Suppress("DEPRECATION")
          val downloads =
              Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
          File(downloads, filename).writeText(report)
        }
      } catch (_: Throwable) {
        // Best effort — never let the reporter swallow the original crash.
      }
      previous?.uncaughtException(thread, throwable)
    }
  }
}
