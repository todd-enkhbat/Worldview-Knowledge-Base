import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import { useApp, useWorld } from '../../src/app/store.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { recenterWorld } from '../../src/world/camera/OrbitRig.tsx'
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
    getTarget: (out: Vector3) => out.set(0, 0, 0), setLookAt,
  } as unknown as CameraControlsImpl
  registerOrbitControls(c)
  return { c, setLookAt }
}

describe('Recenter world', () => {
  it('moves the already mounted orbit camera immediately for either world', () => {
    loadWorld()
    const { setLookAt } = controls()
    useApp.setState({ mode: 'orbit', view: { architecture: 0.6, world: 'field', flow: true } })
    expect(recenterWorld()).toBe(true)
    expect(setLookAt).toHaveBeenCalledOnce()
    const field = setLookAt.mock.calls[0]!
    expect(field).toHaveLength(7)
    expect(field[6]).toBe(true)
    expect(field[4]).toBe(fieldVerticalBounds(useWorld.getState().nodes.values(), settings).centerY)
    useApp.setState({ view: { architecture: 0.6, world: 'classic', flow: true } })
    expect(recenterWorld()).toBe(true)
    expect(setLookAt).toHaveBeenCalledTimes(2)
    expect(setLookAt.mock.calls[1]![4]).toBe(field[4])
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
