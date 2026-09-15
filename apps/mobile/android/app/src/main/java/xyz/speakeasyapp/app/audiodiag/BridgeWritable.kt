package xyz.speakeasyapp.app.audiodiag

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

/**
 * Converts the store's plain Kotlin maps/lists into the WritableMap/WritableArray
 * values the RN bridge accepts on `promise.resolve` — resolving raw collections
 * throws "Cannot convert argument of type class ..." at the JSI boundary (every
 * drain()/snapshot() in the diag-1.0.74-rc.2 upload failed this way). Mirrors
 * Arguments.makeNativeMap semantics: nested maps and lists convert recursively,
 * Int stays Int while Long/Float coerce to Double, Strings and Booleans pass
 * through, and null values stay explicit nulls, matching the store's deliberate
 * missing-field discipline. Container factories default to the bridge's
 * Arguments factories; JVM tests override them with JavaOnlyMap/JavaOnlyArray.
 */
internal fun populateBridgeMap(
  target: WritableMap,
  source: Map<*, *>,
  newMap: () -> WritableMap = { Arguments.createMap() },
  newArray: () -> WritableArray = { Arguments.createArray() },
) {
  for ((key, value) in source) {
    if (key == null) continue
    putBridgeValue(target, key.toString(), value, newMap, newArray)
  }
}

internal fun populateBridgeArray(
  target: WritableArray,
  source: List<*>,
  newMap: () -> WritableMap = { Arguments.createMap() },
  newArray: () -> WritableArray = { Arguments.createArray() },
) {
  for (value in source) pushBridgeValue(target, value, newMap, newArray)
}

private fun putBridgeValue(
  target: WritableMap,
  key: String,
  value: Any?,
  newMap: () -> WritableMap,
  newArray: () -> WritableArray,
) {
  when (value) {
    null -> target.putNull(key)
    is Map<*, *> -> {
      val nested = newMap()
      populateBridgeMap(nested, value, newMap, newArray)
      target.putMap(key, nested)
    }
    is List<*> -> {
      val nested = newArray()
      populateBridgeArray(nested, value, newMap, newArray)
      target.putArray(key, nested)
    }
    is String -> target.putString(key, value)
    is Int -> target.putInt(key, value)
    is Long, is Float, is Double -> target.putDouble(key, (value as Number).toDouble())
    is Boolean -> target.putBoolean(key, value)
    else -> throw IllegalArgumentException(
      "unconvertible diagnostic value for $key: ${value::class.java.name}",
    )
  }
}

private fun pushBridgeValue(
  target: WritableArray,
  value: Any?,
  newMap: () -> WritableMap,
  newArray: () -> WritableArray,
) {
  when (value) {
    null -> target.pushNull()
    is Map<*, *> -> {
      val nested = newMap()
      populateBridgeMap(nested, value, newMap, newArray)
      target.pushMap(nested)
    }
    is List<*> -> {
      val nested = newArray()
      populateBridgeArray(nested, value, newMap, newArray)
      target.pushArray(nested)
    }
    is String -> target.pushString(value)
    is Int -> target.pushInt(value)
    is Long, is Float, is Double -> target.pushDouble((value as Number).toDouble())
    is Boolean -> target.pushBoolean(value)
    else -> throw IllegalArgumentException(
      "unconvertible diagnostic value: ${value::class.java.name}",
    )
  }
}
