package xyz.speakeasyapp.app.signal

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SignalProtocolPackage : ReactPackage {
  // Both the 1:1 and group-messaging bridges live here — they share the
  // same SpeakeasySignalStore singleton and SQLCipher store, so it makes
  // sense to ship them as one ReactPackage.
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
      listOf(SignalProtocolModule(ctx), GroupMessagingModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}
