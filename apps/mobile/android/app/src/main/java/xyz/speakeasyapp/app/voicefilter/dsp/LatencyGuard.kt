package xyz.speakeasyapp.app.voicefilter.dsp

/**
 * Rolling 3-frame breach detector for the Private Call DSP latency
 * budget. Per the locked plan: the filter must stay under 80ms p50 /
 * 120ms p95 on phone CPUs. If three consecutive frames exceed
 * [budgetMicros], we surface `latency_exceeded` to the JS shim and the
 * orchestrator ends the call (failure-closed brand promise).
 *
 * The breach signal is intentionally a *consecutive* count, not a
 * sliding p95, because:
 *   - One slow frame doesn't matter: ART JIT compilation, GC pauses,
 *     and OS preemption all produce isolated outliers.
 *   - Three slow frames in a row at 10ms cadence ⇒ the filter is
 *     persistently >100ms slow — that's an actual latency regression
 *     worth ending the call over.
 *
 * Not thread-safe. The single WebRTC audio-record thread is the only
 * caller. Returning true is one-shot: caller is expected to tear down
 * the filter; if the filter is reused, [reset] before re-arming.
 */
class LatencyGuard(
    /** Per-frame budget in microseconds (1_000 µs = 1 ms). */
    private val budgetMicros: Long,
    /** Consecutive over-budget frames to trip the guard. */
    private val consecutiveBreachLimit: Int = 3,
) {
  private var consecutiveBreaches = 0
  private var tripped = false

  /**
   * Record the elapsed time for the most recent frame. Returns true
   * once [consecutiveBreachLimit] consecutive frames have all exceeded
   * the budget; thereafter keeps returning true until [reset] is
   * called.
   */
  fun recordFrame(elapsedMicros: Long): Boolean {
    if (tripped) return true
    if (elapsedMicros > budgetMicros) {
      consecutiveBreaches += 1
      if (consecutiveBreaches >= consecutiveBreachLimit) {
        tripped = true
        return true
      }
    } else {
      consecutiveBreaches = 0
    }
    return false
  }

  fun reset() {
    consecutiveBreaches = 0
    tripped = false
  }

  /** Exposed for diagnostics; do not gate behavior on this. */
  fun isTripped(): Boolean = tripped
}
