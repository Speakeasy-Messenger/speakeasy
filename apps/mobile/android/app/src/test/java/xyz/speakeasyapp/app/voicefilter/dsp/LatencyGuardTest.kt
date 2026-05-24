package xyz.speakeasyapp.app.voicefilter.dsp

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LatencyGuardTest {

  @Test
  fun `does not trip on a single slow frame`() {
    val g = LatencyGuard(budgetMicros = 1_000L)
    assertFalse(g.recordFrame(2_000L))
    assertFalse(g.isTripped())
  }

  @Test
  fun `does not trip when slow frames are not consecutive`() {
    val g = LatencyGuard(budgetMicros = 1_000L)
    assertFalse(g.recordFrame(2_000L))
    assertFalse(g.recordFrame(500L)) // resets the counter
    assertFalse(g.recordFrame(2_000L))
    assertFalse(g.recordFrame(2_000L)) // 2 in a row, still below the 3 limit
    assertFalse(g.isTripped())
  }

  @Test
  fun `trips on three consecutive over-budget frames`() {
    val g = LatencyGuard(budgetMicros = 1_000L)
    assertFalse(g.recordFrame(2_000L))
    assertFalse(g.recordFrame(2_000L))
    assertTrue(g.recordFrame(2_000L))
    assertTrue(g.isTripped())
  }

  @Test
  fun `stays tripped once tripped`() {
    val g = LatencyGuard(budgetMicros = 1_000L)
    g.recordFrame(2_000L)
    g.recordFrame(2_000L)
    g.recordFrame(2_000L)
    assertTrue(g.recordFrame(500L)) // fast frame, but already tripped
    assertTrue(g.isTripped())
  }

  @Test
  fun `reset un-trips the guard`() {
    val g = LatencyGuard(budgetMicros = 1_000L)
    g.recordFrame(2_000L)
    g.recordFrame(2_000L)
    g.recordFrame(2_000L)
    assertTrue(g.isTripped())
    g.reset()
    assertFalse(g.isTripped())
    assertFalse(g.recordFrame(500L))
  }

  @Test
  fun `honors a custom breach limit`() {
    val g = LatencyGuard(budgetMicros = 1_000L, consecutiveBreachLimit = 5)
    repeat(4) { assertFalse(g.recordFrame(2_000L)) }
    assertTrue(g.recordFrame(2_000L))
  }
}
