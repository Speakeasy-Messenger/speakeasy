package xyz.speakeasyapp.app.fileopener

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class FileOpenerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SpeakeasyFileOpener"

  @ReactMethod
  fun openFile(path: String, mime: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) {
        promise.reject("not_found", "File does not exist")
        return
      }

      val uri =
          FileProvider.getUriForFile(
              reactContext,
              "${reactContext.packageName}.fileprovider",
              file,
          )
      val viewIntent =
          Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime.ifBlank { "*/*" })
            clipData = ClipData.newUri(reactContext.contentResolver, file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
      val chooser =
          Intent.createChooser(viewIntent, "Open with").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }

      reactContext.startActivity(chooser)
      promise.resolve(true)
    } catch (err: ActivityNotFoundException) {
      promise.reject("no_activity", "No app can open this file type", err)
    } catch (err: Exception) {
      promise.reject("open_failed", err.message ?: "Could not open file", err)
    }
  }
}
