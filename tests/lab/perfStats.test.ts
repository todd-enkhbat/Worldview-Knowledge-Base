import { describe, expect, it } from 'vitest'
import { CameraPath, perfKeyframes } from '../../src/lab/perf/cameraPath.ts'
import { P_LIMITS, PerfRecorder, estimateVsync, percentile, phaseReport, summarize } from '../../src/lab/perf/stats.ts'

describe('perf stats', () => {
  it('percentile uses nearest rank and summarize ignores non-finite values', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(v, 0.5)).toBe(5)
    expect(percentile(v, 0.99)).toBe(10)
    const s = summarize([3, Number.NaN, 1, 2])
    expect(s.n).toBe(3)
    expect(s.median).toBe(2)
    expect(s.mean).toBe(2)
    expect(summarize([]).n).toBe(0)
  })

  it('estimates vsync from rAF intervals and snaps to a panel rate', () => {
    const at60 = Array.from({ length: 300 }, (_, i) => 16.67 + ((i * 7) % 5) * 0.05 - 0.1)
    expect(estimateVsync(at60)).toMatchObject({ hz: 60, method: 'snapped' })
    // A ProMotion panel with some missed frames still reads as 120 Hz.
    const at120 = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 16.67 : 8.33))
    expect(estimateVsync(at120).hz).toBe(120)
    // Off-grid timing falls back to the raw low percentile.
    expect(estimateVsync(Array(50).fill(37)).method).toBe('raw')
    expect(estimateVsync([]).method).toBe('none')
  })

  it('counts frames over 1.5× vsync and reports main-thread work', () => {
    const frames = Array.from({ length: 200 }, (_, i) => ({ t: i * 16.67, interval: i < 3 ? 33.4 : 16.67, phase: 'path' }))
    const work = Array.from({ length: 200 }, (_, i) => ({ t: i * 16.67, main: i % 2 ? 4 : 6, gpu: i % 3 ? 5 : null, phase: 'path', calls: 100, triangles: 1e5, points: 2e4 }))
    const r = phaseReport(frames, work, 1000 / 60)
    expect(r.frames).toBe(200)
    expect(r.slowFrames).toBe(3)
    expect(r.slowShare).toBeCloseTo(0.015, 6)
    expect(r.droppedFrames).toBe(0)
    expect(r.mainMs.median).toBe(4)
    expect(r.gpuMs!.median).toBe(5)
    expect(r.fps).toBeGreaterThan(58)
    expect(r.slowShare > P_LIMITS.slowShare).toBe(true)
  })

  it('PerfRecorder tags samples with the phase and skips gaps', () => {
    const rec = new PerfRecorder()
    rec.raf(0)
    rec.phase = 'path'
    for (let i = 1; i <= 120; i++) {
      rec.raf(i * 16.67)
      rec.frame(i * 16.67 + 5, 3, 10, 20, 30)
    }
    rec.raf(120 * 16.67 + 5000) // hidden tab: not a frame
    rec.phase = 'scrub'
    for (let i = 1; i <= 60; i++) {
      rec.raf(120 * 16.67 + 5000 + i * 16.67)
      rec.frame(0, 9, 10, 20, 30)
    }
    rec.phase = null
    rec.raf(1e6)
    const r = rec.report(['path', 'scrub'])
    expect(r.phases.path.frames).toBe(120)
    expect(r.phases.scrub.frames).toBe(60)
    expect(r.all.frames).toBe(180)
    expect(r.vsync.hz).toBe(60)
    expect(r.all.mainMs.median).toBe(3)
    expect(r.verdict.pass).toBe(true)
  })
})

describe('perf camera path', () => {
  const mems = [{ anchor: [20, 60, 5] as [number, number, number] }, { anchor: [-15, 200, 30] as [number, number, number] }]
  const keys = perfKeyframes(mems, 432)

  it('starts with the establishing shot, visits each memory, ends at the present', () => {
    expect(keys.length).toBe(4)
    expect(keys[1].target).toEqual([20, 60, 5])
    expect(keys[2].target).toEqual([-15, 200, 30])
    expect(keys[3].pos[1]).toBeGreaterThan(432)
  })

  it('is continuous, hits its keyframes and clamps to the ends', () => {
    const path = new CameraPath(keys, 30)
    const p = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
    const t = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
    path.at(0, p, t)
    expect([p.x, p.y, p.z]).toEqual(keys[0].pos.map((v) => Math.fround(v)))
    path.at(-3, p, t)
    expect(p.x).toBeCloseTo(keys[0].pos[0], 4)
    path.at(30, p, t)
    expect(p.y).toBeCloseTo(keys[3].pos[1], 3)
    path.at(99, p, t)
    expect(t.y).toBeCloseTo(keys[3].target[1], 3)
    path.at(0, p, t)
    let prev = { x: p.x, y: p.y, z: p.z }
    let maxStep = 0
    for (let i = 1; i <= 1800; i++) {
      path.at(i / 60, p, t)
      maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z))
      prev = { x: p.x, y: p.y, z: p.z }
    }
    // A few hundred units in 30 s: no teleports between frames.
    expect(maxStep).toBeLessThan(2)
  })

  it('falls back to a spiral without memories', () => {
    const k = perfKeyframes([], 100)
    expect(k.length).toBe(6)
    expect(() => new CameraPath(k, 30)).not.toThrow()
  })
})
