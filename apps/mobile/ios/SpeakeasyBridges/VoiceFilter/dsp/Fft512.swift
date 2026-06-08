//
//  Fft512.swift
//  Speakeasy — Private Call voice filter
//
//  512-point radix-2 Cooley-Tukey FFT — lower-latency sibling of
//  Fft1024 (Swift port of Fft512.kt). Used by PhaseVocoderPitchShifter
//  to halve the analysis window for the 1.0.x latency fix (measured
//  30.3 ms @1024 → 16.6 ms @512), at the cost of coarser bin resolution
//  (48000/512 ≈ 94 Hz/bin). Allocation-free per call after init().
//

import Foundation

final class Fft512 {
  static let SIZE = 512
  private static let SIZE_LOG2 = 9

  private let cosTable: [Float]
  private let sinTable: [Float]

  init() {
    var c = [Float](repeating: 0, count: Fft512.SIZE / 2)
    var s = [Float](repeating: 0, count: Fft512.SIZE / 2)
    for i in 0..<(Fft512.SIZE / 2) {
      let theta = -2.0 * Double.pi * Double(i) / Double(Fft512.SIZE)
      c[i] = Float(cos(theta))
      s[i] = Float(sin(theta))
    }
    self.cosTable = c
    self.sinTable = s
  }

  func forward(_ re: inout [Float], _ im: inout [Float]) {
    precondition(re.count == Fft512.SIZE && im.count == Fft512.SIZE,
                 "buffers must be SIZE=\(Fft512.SIZE)")
    bitReverse(&re, &im)
    butterflies(&re, &im)
  }

  func inverse(_ re: inout [Float], _ im: inout [Float]) {
    precondition(re.count == Fft512.SIZE && im.count == Fft512.SIZE,
                 "buffers must be SIZE=\(Fft512.SIZE)")
    for i in 0..<Fft512.SIZE { im[i] = -im[i] }
    bitReverse(&re, &im)
    butterflies(&re, &im)
    let s = 1.0 / Float(Fft512.SIZE)
    for i in 0..<Fft512.SIZE {
      re[i] *= s
      im[i] = -im[i] * s
    }
  }

  private func bitReverse(_ re: inout [Float], _ im: inout [Float]) {
    var j = 0
    let n = Fft512.SIZE
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
    let n = Fft512.SIZE
    var len = 2
    var stage = 0
    while stage < Fft512.SIZE_LOG2 {
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
