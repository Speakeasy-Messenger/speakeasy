package xyz.speakeasyapp.app.version

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import xyz.speakeasyapp.app.BuildConfig

/**
 * Exposes the build-time-baked app version to JS.
 *
 * `versionName` and `versionCode` are derived in app/build.gradle from
 * the git tag at build time (see the top-of-file `deriveVersionString`
 * helper). The JS side reads them via `getConstants()` so there's no
 * async hop at every call site — values are available synchronously
 * from the first JS module load.
 *
 * Why constants instead of a method:
 *   - The values never change at runtime.
 *   - Synchronous access means apps/mobile/src/version.ts can export a
 *     plain `APP_VERSION` constant, mirroring the prior shape of the
 *     hardcoded constants it replaces. No call-site refactor needed
 *     for code that does `import { APP_VERSION } from './version'`.
 *
 * The matching JS module is `apps/mobile/src/version.ts`, which falls
 * back to a sentinel for non-RN contexts (vitest, web previews).
 */
class VersionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SpeakeasyVersion"

  override fun getConstants(): Map<String, Any> = mapOf(
      "versionName" to BuildConfig.VERSION_NAME,
      "versionCode" to BuildConfig.VERSION_CODE,
  )
}
