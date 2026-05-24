//
//  LatencyGuard.swift
//  Speakeasy — Phase 5j Private Call voice filter
//
//  Swift port of
//  apps/mobile/android/.../voicefilter/dsp/LatencyGuard.kt
//
//  Rolling 3-frame breach detector for the DSP latency budget. Per
//  the locked plan: 80ms p50 / 120ms p95 on phone CPUs. One slow
//  frame is JIT / GC / scheduling noise; three in a row trips the
//  guard and the orchestrator ends the call (failure-closed brand
//  promise).
//
//  Not thread-safe. The single AVAudioEngine capture thread is the
//  only caller. Returning true is one-shot; reset() to re-arm.
//

import Foundation

final class LatencyGuard {
  private let budgetMicros: Int64
  private let consecutiveBreachLimit: Int
  private var consecutiveBreaches: Int = 0
  private var tripped: Bool = false

  init(budgetMicros: Int64, consecutiveBreachLimit: Int = 3) {
    self.budgetMicros = budgetMicros
    self.consecutiveBreachLimit = consecutiveBreachLimit
  }

  /// Returns true once `consecutiveBreachLimit` consecutive frames
  /// have all exceeded the budget; thereafter stays true until reset.
  @discardableResult
  func recordFrame(elapsedMicros: Int64) -> Bool {
    if tripped { return true }
    if elapsedMicros > budgetMicros {
      consecutiveBreaches += 1
      if consecutiveBreaches >= consecutiveBreachLimit {
        tripped = true
        return true
      }
    } else {
      consecutiveBreaches = 0
    }
    return false
  }

  func reset() {
    consecutiveBreaches = 0
    tripped = false
  }

  func isTripped() -> Bool { tripped }
}
