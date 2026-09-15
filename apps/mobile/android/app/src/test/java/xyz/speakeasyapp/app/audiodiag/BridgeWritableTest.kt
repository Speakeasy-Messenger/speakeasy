package xyz.speakeasyapp.app.audiodiag

import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeWritableTest {

  @Test
  fun `drained entries convert to writable arrays of writable maps`() {
    val entry = linkedMapOf<String, Any?>(
      "event" to "native-audio",
      "nativeElapsedMs" to 1234L,
      "sampleRate" to 48000,
      "rms" to 0.25,
      "important" to true,
      "error" to null,
      "availableDevices" to listOf("earpiece", "bluetooth-sco"),
      "nested" to linkedMapOf("mode" to 3, "playbackHeadDelta" to 7L),
    )
    val array = JavaOnlyArray()
    populateBridgeArray(array, listOf(entry), { JavaOnlyMap() }, { JavaOnlyArray() })

    assertEquals(1, array.size())
    val map = array.getMap(0) as JavaOnlyMap
    assertEquals("native-audio", map.getString("event"))
    assertEquals(1234.0, map.getDouble("nativeElapsedMs"), 0.0)
    assertEquals(48000, map.getInt("sampleRate"))
    assertEquals(0.25, map.getDouble("rms"), 0.0)
    assertEquals(true, map.getBoolean("important"))
    assertTrue(map.hasKey("error"))
    assertNull(map.getString("error"))
    assertEquals(JavaOnlyArray.of("earpiece", "bluetooth-sco"), map.getArray("availableDevices"))
    val nested = map.getMap("nested") as JavaOnlyMap
    assertEquals(3, nested.getInt("mode"))
    assertEquals(7.0, nested.getDouble("playbackHeadDelta"), 0.0)
  }

  @Test
  fun `snapshot shape keeps explicit nulls and converts the device list`() {
    val snapshot = linkedMapOf<String, Any?>(
      "event" to "platform snapshot",
      "trigger" to "manual",
      "nativeElapsedMs" to 5678L,
      "callId" to null,
      "mode" to 3,
      "microphoneMuted" to false,
      "effectiveCommunicationDevice" to null,
      "availableDevices" to null,
    )
    val map = JavaOnlyMap()
    populateBridgeMap(map, snapshot, { JavaOnlyMap() }, { JavaOnlyArray() })

    assertEquals("platform snapshot", map.getString("event"))
    assertEquals("manual", map.getString("trigger"))
    assertEquals(5678.0, map.getDouble("nativeElapsedMs"), 0.0)
    assertTrue(map.hasKey("callId"))
    assertNull(map.getString("callId"))
    assertEquals(3, map.getInt("mode"))
    assertEquals(false, map.getBoolean("microphoneMuted"))
    assertTrue(map.hasKey("effectiveCommunicationDevice"))
    assertNull(map.getString("effectiveCommunicationDevice"))
    assertTrue(map.hasKey("availableDevices"))
    assertTrue(map.isNull("availableDevices"))
  }
}
