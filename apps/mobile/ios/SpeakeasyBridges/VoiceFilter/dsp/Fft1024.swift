//
//  Fft1024.swift
//  Speakeasy — Phase 5j Private Call voice filter, Phase 2
//
//  Swift port of
//  apps/mobile/android/.../voicefilter/dsp/Fft1024.kt
//
//  In-place radix-2 Cooley-Tukey FFT for the phase vocoder pitch
//  shifter. Size fixed at 1024 (matches the vocoder analysis
//  window). Allocation-free per call after init().
//
//  # Future
//
//  Apple's Accelerate.framework (`vDSP_fft_zrip`) is ~5-10× faster
//  for the same size. Swapping is straightforward — same input
//  shape, same output bins, with the caveat that vDSP uses a
//  packed real-input format that needs a small wrapper. Deferred
//  to a perf pass once the algorithm itself is validated in the
//  field; for now the cross-platform hand-rolled version keeps
//  Kotlin and Swift bit-for-bit identical.
//

import Foundation

final class Fft1024 {
  static let SIZE = 1024
  private static let SIZE_LOG2 = 10

  private let cosTable: [Float]
  private let sinTable: [Float]

  init() {
    var c = [Float](repeating: 0, count: Fft1024.SIZE / 2)
    var s = [Float](repeating: 0, count: Fft1024.SIZE / 2)
    for i in 0..<(Fft1024.SIZE / 2) {
      let theta = -2.0 * Double.pi * Double(i) / Double(Fft1024.SIZE)
      c[i] = Float(cos(theta))
      s[i] = Float(sin(theta))
    }
    self.cosTable = c
    self.sinTable = s
  }

  /// Forward FFT in-place. `re` and `im` must each be length SIZE.
  func forward(_ re: inout [Float], _ im: inout [Float]) {
    precondition(re.count == Fft1024.SIZE && im.count == Fft1024.SIZE,
                 "buffers must be SIZE=\(Fft1024.SIZE)")
    bitReverse(&re, &im)
    butterflies(&re, &im)
  }

  /// Inverse FFT in-place. Conjugate → forward FFT → conjugate + scale 1/N.
  func inverse(_ re: inout [Float], _ im: inout [Float]) {
    precondition(re.count == Fft1024.SIZE && im.count == Fft1024.SIZE,
                 "buffers must be SIZE=\(Fft1024.SIZE)")
    for i in 0..<Fft1024.SIZE { im[i] = -im[i] }
    bitReverse(&re, &im)
    butterflies(&re, &im)
    let s = 1.0 / Float(Fft1024.SIZE)
    for i in 0..<Fft1024.SIZE {
      re[i] *= s
      im[i] = -im[i] * s
    }
  }

  private func bitReverse(_ re: inout [Float], _ im: inout [Float]) {
    var j = 0
    let n = Fft1024.SIZE
    for i in 1..<n {
      var bit = n >> 1
      while (j & bit) != 0 {
        j ^= bit
        bit >>= 1
      }
      j ^= bit
      if i < j {
        let tr = re[i]; re[i] = re[j]; re[j] = tr
        let ti = im[i]; im[i] = im[j]; im[j] = ti
      }
    }
  }

  private func butterflies(_ re: inout [Float], _ im: inout [Float]) {
    let n = Fft1024.SIZE
    var len = 2
    var stage = 0
    while stage < Fft1024.SIZE_LOG2 {
      let halfLen = len / 2
      let tableStep = n / len
      var i = 0
      while i < n {
        var k = 0
        for jj in 0..<halfLen {
          let l = i + jj
          let u = l + halfLen
          let cosK = cosTable[k]
          let sinK = sinTable[k]
          let tr = re[u] * cosK - im[u] * sinK
          let ti = re[u] * sinK + im[u] * cosK
          re[u] = re[l] - tr
          im[u] = im[l] - ti
          re[l] = re[l] + tr
          im[l] = im[l] + ti
          k += tableStep
        }
        i += len
      }
      len <<= 1
      stage += 1
    }
  }
}
