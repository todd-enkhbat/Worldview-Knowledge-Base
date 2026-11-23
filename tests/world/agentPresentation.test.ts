import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { advanceAgentTime, AGENT_BODY_DIAMETER, AGENT_BODY_PIXELS, AGENT_ROUTE_SPEED, agentBodyScale, agentOverlayShift, agentPresentationOffset, sampleAgentPresentation, smoothAgentOffset } from '../../src/world/agents/presentation.ts'
import { sampleAgentRoute } from '../../src/world/agents/model.ts'

const poses = { index: new Map([['a', 0], ['b', 1], ['future', 2]]), pos: new Float32Array([0, 180, 0, 90, 270, 40, 9000, 0, 0]), born: new Uint8Array([1, 1, 0]) }
const home = { x: -5, y: 190, z: -5 }

describe('readable world companions', () => {
  it('projects a quiet 32px body at close and full-world distances', () => {
    for (const depth of [64, 600, 1600, 3500]) for (const height of [720, 844]) for (const fov of [40, 65]) {
      const camera = new PerspectiveCamera(fov, 1.5, .1, 10000)
      camera.updateMatrixWorld()
      const radius = AGENT_BODY_DIAMETER * agentBodyScale(depth, fov, height) / 2
      const left = new Vector3(-radius, 0, -depth).project(camera)
      const right = new Vector3(radius, 0, -depth).project(camera)
      expect((right.x - left.x) * height * camera.aspect / 2).toBeCloseTo(AGENT_BODY_PIXELS, 5)
    }
  })

  it('freezes travel and articulation when ambient flow or a query is paused', () => {
    expect(advanceAgentTime(12, .05, false, true)).toBe(12)
    expect(advanceAgentTime(12, .05, true, false)).toBe(12)
    expect(advanceAgentTime(12, 4, true, true)).toBeCloseTo(12.1)
    expect(advanceAgentTime(12, -4, true, true)).toBe(12)
    expect(advanceAgentTime(12, NaN, true, true)).toBe(12)
    const a = { x: 0, y: 0, z: 0 }, b = { ...a }
    sampleAgentPresentation(['a', 'b'], poses, 12, home, 1, a)
    sampleAgentPresentation(['a', 'b'], poses, advanceAgentTime(12, .1, false, true), home, 1, b)
    expect(b).toEqual(a)
  })

  it('patrols in bounded 3D motion around actual born route samples', () => {
    const point = { x: 0, y: 0, z: 0 }, route = { ...point }
    for (const time of [0, 4.5, 9, 18, 100]) {
      expect(sampleAgentPresentation(['a', 'missing', 'b', 'future'], poses, time, home, 1, point)).toBe(2)
      sampleAgentRoute(['a', 'b'], poses, time * AGENT_ROUTE_SPEED, home, route)
      expect(Math.hypot(point.x - route.x, point.z - route.z)).toBeGreaterThanOrEqual(64)
      expect(Math.hypot(point.x - route.x, point.z - route.z)).toBeLessThanOrEqual(76)
      expect(point.y - route.y).toBeGreaterThan(27)
      expect(point.y - route.y).toBeLessThan(49)
    }
    expect(sampleAgentPresentation(['future'], poses, 0, home, 0, point)).toBe(0)
    expect(Math.hypot(point.x - home.x, point.z - home.z)).toBe(70)
  })

  it('clears the real reminder together with the body and caption using a bounded shift', () => {
    const reminder = [[0, 156, 1090, 200]] as const
    const shift = agentOverlayShift(600, 180, reminder, 720, 180)
    expect(shift).toBe(67)
    expect(180 + shift - 40).toBeGreaterThan(200)
    expect(agentOverlayShift(600, 400, reminder, 720, 180)).toBe(0)
    expect(agentOverlayShift(1200, 180, reminder, 720, 180)).toBe(0)
    expect(agentOverlayShift(600, 180, reminder, 720, 20)).toBe(0)
    expect(reminder).toEqual([[0, 156, 1090, 200]])
  })

  it('separates overlapping paused bodies and their captions without moving the actual route', () => {
    const guide = { x: 650, y: 248, captionWidth: 52 }
    const memory = { x: 650, y: 248, captionWidth: 124 }
    const reminder = [[0, 156, 1090, 200]] as const
    const shift = agentPresentationOffset(memory, [guide], reminder, 720, 120)
    expect(Math.hypot(shift.x, shift.y)).toBeGreaterThanOrEqual(76)
    expect(Math.hypot(shift.x, shift.y)).toBeLessThanOrEqual(120)
    expect(memory.y + shift.y - 40).toBeGreaterThan(200)
    // Both captions retain their own horizontal footprint when the bodies share a height.
    expect(Math.abs(shift.x)).toBeGreaterThan((guide.captionWidth + memory.captionWidth) / 2)
    expect(agentPresentationOffset(memory, [guide], reminder, 720, 120)).toEqual(shift)
    expect(memory).toEqual({ x: 650, y: 248, captionWidth: 124 })
    expect(agentPresentationOffset({ ...memory, x: 850 }, [guide], reminder, 720, 120)).toEqual({ x: 0, y: 0 })
  })

  it('bounds the total overlay and neighbor correction to the same local world budget', () => {
    const point = { x: 600, y: 180, captionWidth: 100 }
    const reminder = [[0, 156, 1090, 200]] as const
    const guide = { x: 600, y: 247, captionWidth: 52 }
    const shift = agentPresentationOffset(point, [guide], reminder, 720, 150)
    expect(Math.hypot(shift.x, shift.y)).toBeLessThanOrEqual(150)
    expect(Math.hypot(point.x + shift.x - guide.x, point.y + shift.y - guide.y)).toBeGreaterThanOrEqual(76)
    expect(point.y + shift.y - 40).toBeGreaterThan(200)
  })

  it('eases clearance continuously at the same rate across rendering frame rates', () => {
    const run = (fps: number) => {
      let current = { x: 0, y: 0 }
      for (let frame = 0; frame < fps; frame++) current = smoothAgentOffset(current, { x: 100, y: 60 }, 1 / fps, true)
      return current
    }
    const first = smoothAgentOffset({ x: 0, y: 0 }, { x: 100, y: 60 }, 1 / 60, true)
    expect(first.x).toBeGreaterThan(0)
    expect(first.x).toBeLessThan(8)
    for (const fps of [30, 60, 144]) {
      expect(run(fps).x).toBeCloseTo(run(60).x, 8)
      expect(run(fps).y).toBeCloseTo(run(60).y, 8)
    }
    const paused = { x: 37.2, y: -4.8 }
    expect(smoothAgentOffset(paused, { x: 100, y: 60 }, 1 / 60, false)).toEqual(paused)
    expect(smoothAgentOffset(paused, { x: 100, y: 60 }, 0, true)).toEqual(paused)
    expect(Math.hypot(...Object.values(smoothAgentOffset({ x: 0, y: 0 }, { x: 10000, y: 10000 }, .1, true)))).toBeLessThanOrEqual(180)
  })

  it('keeps a stable side of a neighbor instead of alternating symmetric candidates', () => {
    const neighbor = { x: 650, y: 248, captionWidth: 52 }
    const previous = agentPresentationOffset({ x: 650, y: 248, captionWidth: 124 }, [neighbor], [], 720, 150)
    for (const noise of [-.1, .1, -.01, .01]) {
      const next = agentPresentationOffset({ x: 650 + noise, y: 248, captionWidth: 124 }, [neighbor], [], 720, 150, previous)
      expect(Math.sign(next.x)).toBe(Math.sign(previous.x))
      expect(Math.hypot(next.x - previous.x, next.y - previous.y)).toBeLessThan(1)
    }
  })
})
