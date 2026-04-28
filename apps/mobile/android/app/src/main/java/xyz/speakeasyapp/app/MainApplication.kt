package xyz.speakeasyapp.app

import android.app.Application
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
}
