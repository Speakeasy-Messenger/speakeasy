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
import xyz.speakeasyapp.app.signal.SignalProtocolPackage
import xyz.speakeasyapp.app.version.VersionPackage
import xyz.speakeasyapp.app.vouchflow.VouchflowPackage
import dev.vouchflow.sdk.Vouchflow
import dev.vouchflow.sdk.VouchflowConfig
import dev.vouchflow.sdk.VouchflowEnvironment

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
    Vouchflow.configure(
        VouchflowConfig(
            apiKey = BuildConfig.VOUCHFLOW_API_KEY,
            environment =
                if (BuildConfig.VOUCHFLOW_ENVIRONMENT == "sandbox")
                    VouchflowEnvironment.SANDBOX
                else VouchflowEnvironment.PRODUCTION,
        ))
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
