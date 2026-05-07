package xyz.speakeasyapp.app

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Speakeasy"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Pass `null` instead of `savedInstanceState` so Android does NOT
   * try to restore the FragmentManager state. `react-native-screens`
   * can't reconstitute its `ScreenFragment`s from a Bundle — when
   * the Android system kills the process while the app is in
   * background and then restores it on foreground, the FragmentState
   * deserializer crashes with:
   *
   *   IllegalStateException: Screen fragments should never be restored
   *
   * RN rebuilds the entire navigation tree from JS state on relaunch
   * anyway; we don't lose anything by skipping the system's
   * fragment restoration. Standard `react-native-screens` workaround
   * (their docs flag this for new-arch RN apps).
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
