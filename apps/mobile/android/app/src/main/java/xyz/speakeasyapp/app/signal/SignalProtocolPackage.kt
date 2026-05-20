package xyz.speakeasyapp.app.signal

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import xyz.speakeasyapp.app.db.SecureKvModule
import xyz.speakeasyapp.app.db.SpeakeasyDbModule

class SignalProtocolPackage : ReactPackage {
  // The 1:1, group-messaging, secure-KV and SpeakeasyDb-state bridges
  // live here — they all share the same SQLCipher SpeakeasyDb, so it
  // makes sense to ship them as one ReactPackage.
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
      listOf(
          SignalProtocolModule(ctx),
          GroupMessagingModule(ctx),
          SecureKvModule(ctx),
          SpeakeasyDbModule(ctx),
      )

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}
