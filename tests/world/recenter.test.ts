import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import { useApp, useWorld } from '../../src/app/store.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { recenterWorld } from '../../src/world/camera/OrbitRig.tsx'
import { updateCameraFlight } from '../../src/world/camera/cameraFlight.ts'
import { registerOrbitControls } from '../../src/world/camera/flyTo.ts'
import { resetField } from '../../src/world/field/runtime.ts'
import { fieldVerticalBounds } from '../../src/world/field/layout.ts'

const originalApp = useApp.getState()
const originalWorld = useWorld.getState()
afterEach(() => {
  registerOrbitControls(null)
  resetField()
  useApp.setState(originalApp, true)
  useWorld.setState(originalWorld, true)
})

const T0 = Date.UTC(1990, 0, 1)
const now = Date.UTC(2026, 10, 4)
const settings = { T0, yPerYear: 12, stepsPerYear: 600 } as WorldSettings
function loadWorld() {
  useWorld.setState({ nodes: new Map(buildDemoWorld(T0, now).map((r) => [r.id, r])), settings })
}
function controls() {
  const setLookAt = vi.fn().mockResolvedValue(undefined)
  const c = {
    camera: new PerspectiveCamera(50, 1.5, 0.1, 10000), distance: 150,
    getTarget: (out: Vector3) => out.set(0, 0, 0), getPosition: (out: Vector3) => out.set(180, 90, 30), setLookAt, update: vi.fn(),
  } as unknown as CameraControlsImpl
  registerOrbitControls(c)
  return { setLookAt, finish: () => { for (let frame = 0; frame < 9; frame++) updateCameraFlight(c, 0.1) } }
}

describe('Recenter world', () => {
  it('frames the already mounted orbit camera for either world', () => {
    loadWorld()
    const { setLookAt, finish } = controls()
    useApp.setState({ mode: 'orbit', view: { architecture: 0.6, world: 'field', flow: true } })
    expect(recenterWorld()).toBe(true)
    finish()
    const field = setLookAt.mock.calls.at(-1)!
    expect(field).toHaveLength(7)
    expect(field[6]).toBe(false)
    expect(field[4]).toBe(fieldVerticalBounds(useWorld.getState().nodes.values(), settings).centerY)
    useApp.setState({ view: { architecture: 0.6, world: 'classic', flow: true } })
    expect(recenterWorld()).toBe(true)
    finish()
    expect(setLookAt.mock.calls.at(-1)![4]).toBe(field[4])
  })

  it('switches flight back to orbit and parks the reframe until controls mount', () => {
    loadWorld()
    useApp.setState({ mode: 'first_person' })
    expect(recenterWorld()).toBe(true)
    expect(useApp.getState().mode).toBe('orbit')
  })

  it('leaves an in-progress scene transition undisturbed', () => {
    loadWorld()
    const { setLookAt } = controls()
    useApp.setState({ mode: 'entering' })
    expect(recenterWorld()).toBe(false)
    expect(useApp.getState().mode).toBe('entering')
    expect(setLookAt).not.toHaveBeenCalled()
  })
})
