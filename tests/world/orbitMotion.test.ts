// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import CameraControls from 'camera-controls'
import * as THREE from 'three'
import { useApp, useWorld } from '../../src/app/store.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { flyTo, registerOrbitControls } from '../../src/world/camera/flyTo.ts'
import { requestEstablishingShot } from '../../src/world/camera/OrbitRig.tsx'
import { createOrbitMotionDriver, ORBIT_MOTION_RATE, ORBIT_POLAR_AMPLITUDE, sampleOrbitMotion, stopOrbitMotion, toggleOrbitMotion, useOrbitMotion } from '../../src/world/camera/orbitMotion.ts'

CameraControls.install({ THREE })
const initialApp = useApp.getState(), initialWorld = useWorld.getState()
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  registerOrbitControls(null)
  stopOrbitMotion()
  useApp.setState(initialApp, true)
  useWorld.setState(initialWorld, true)
  vi.unstubAllGlobals()
})

function setup() {
  useApp.setState({ mode: 'orbit', selectedId: null, focusedId: null })
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 10000)
  const controls = new CameraControls(camera)
  controls.minDistance = 2.5; controls.maxDistance = 9000
  void controls.setLookAt(420, 230, 310, 120, 150, -50, false)
  controls.update(0)
  registerOrbitControls(controls)
  const driver = createOrbitMotionDriver(controls)
  disposers.push(() => { driver.dispose(); controls.dispose() })
  const advance = (frames: number) => { for (let i = 0; i < frames; i++) { controls.update(1 / 60); driver.update(1 / 60) } }
  return { camera, controls, driver, advance }
}

describe('opt-in orbit motion sampling', () => {
  it('integrates the same eased path at different frame rates without jumping after a stalled frame', () => {
    const run = (hz: number) => {
      let state = { phase: 0, speed: 0 }, azimuth = 0, polar = 0
      for (let frame = 0; frame < hz * 10; frame++) {
        const sample = sampleOrbitMotion(state, 1 / hz, true)
        state = sample; azimuth += sample.azimuthDelta; polar += sample.polarDelta
      }
      return { state, azimuth, polar }
    }
    const a = run(30), b = run(120)
    expect(a.azimuth).toBeCloseTo(b.azimuth, 10)
    expect(a.polar).toBeCloseTo(b.polar, 10)
    expect(a.azimuth).toBeCloseTo(ORBIT_MOTION_RATE * (10 - .65 * (1 - Math.exp(-10 / .65))), 10)
    expect(Math.abs(a.polar)).toBeLessThanOrEqual(ORBIT_POLAR_AMPLITUDE)
    const stalled = sampleOrbitMotion(a.state, 30, true)
    expect(stalled.azimuthDelta).toBeLessThanOrEqual(ORBIT_MOTION_RATE * .1)
    expect(sampleOrbitMotion(a.state, -1, true).azimuthDelta).toBe(0)
  })

  it('eases to rest and keeps polar movement bounded over a long orbit', () => {
    let state = { phase: 0, speed: 0 }, polar = 0
    for (let frame = 0; frame < 60 * 120; frame++) {
      const sample = sampleOrbitMotion(state, 1 / 60, true)
      state = sample; polar += sample.polarDelta
      expect(Math.abs(polar)).toBeLessThanOrEqual(ORBIT_POLAR_AMPLITUDE + 1e-9)
    }
    let last = Infinity
    for (let frame = 0; frame < 300; frame++) {
      const sample = sampleOrbitMotion(state, 1 / 60, false)
      expect(sample.azimuthDelta).toBeLessThanOrEqual(last)
      last = sample.azimuthDelta; state = sample
    }
    expect(state.speed).toBe(0)
    expect(sampleOrbitMotion(state, 1 / 60, false).azimuthDelta).toBe(0)
  })
})

describe('real camera orbit interactions', () => {
  it('starts only explicitly, preserves the pivot and distance, and leaves history untouched', () => {
    expect(useOrbitMotion.getState().playing).toBe(false)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { controls, camera, advance } = setup()
    const pivot = controls.getTarget(new THREE.Vector3(), false), distance = controls.distance
    const before = camera.position.clone(), clock = { ...useApp.getState().clock }
    advance(2)
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-8)
    toggleOrbitMotion()
    expect(useOrbitMotion.getState().playing).toBe(true)
    advance(120)
    expect(camera.position.distanceTo(before)).toBeGreaterThan(10)
    expect(controls.getTarget(new THREE.Vector3(), false).distanceTo(pivot)).toBeLessThan(1e-8)
    expect(controls.distance).toBeCloseTo(distance, 8)
    expect(useApp.getState().clock).toEqual(clock)
    toggleOrbitMotion()
    const paused = camera.position.clone()
    advance(1)
    expect(camera.position.distanceTo(paused)).toBeGreaterThan(0)
    advance(300)
    const rested = camera.position.clone()
    advance(30)
    expect(camera.position.distanceTo(rested)).toBeLessThan(1e-8)
  })

  it('hands control back immediately on a drag, selection, camera mode, fly, reset, or unmount', () => {
    const { controls, camera, driver, advance } = setup()
    const interrupt = (action: () => void) => {
      toggleOrbitMotion(); advance(60)
      expect(useOrbitMotion.getState().playing).toBe(true)
      action()
      expect(useOrbitMotion.getState().playing).toBe(false)
    }
    interrupt(() => controls.dispatchEvent({ type: 'controlstart' }))
    const stopped = camera.position.clone(); advance(30)
    expect(camera.position.distanceTo(stopped)).toBeLessThan(1e-8)
    interrupt(() => useApp.getState().select('actual-note'))
    interrupt(() => useApp.getState().setMode('third_person'))
    useApp.getState().setMode('orbit')
    interrupt(() => { flyTo([60, 170, 80], { transition: false }) })
    interrupt(requestEstablishingShot)
    const note = makeNodeDraft('idea', { id: 'reset-note' })
    useWorld.setState({ loaded: true, nodes: new Map([[note.id, note]]) })
    interrupt(() => useWorld.getState().hydrate(null, []))
    interrupt(() => driver.dispose())
  })

  it('adopts the visible pose rather than jumping to an unfinished camera transition', () => {
    const { controls, camera, driver } = setup()
    const visible = camera.position.clone()
    void controls.setLookAt(-700, 600, 200, -200, 180, 0, true)
    toggleOrbitMotion()
    driver.update(0)
    expect(camera.position.distanceTo(visible)).toBeLessThan(1e-8)
    driver.update(1 / 60)
    expect(camera.position.distanceTo(visible)).toBeLessThan(1)
  })
})
