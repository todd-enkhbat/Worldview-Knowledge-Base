import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import { useApp } from '../../src/app/store.ts'
import type { Vec3 } from '../../src/domain/types.ts'
import { flyTo, registerOrbitControls } from '../../src/world/camera/flyTo.ts'
import { cancelCameraFlight, updateCameraFlight } from '../../src/world/camera/cameraFlight.ts'
import { getPoseTable, setPoseTable } from '../../src/world/poses.ts'

const previousApp = useApp.getState()
const previousPoses = getPoseTable()
afterEach(() => {
  registerOrbitControls(null)
  useApp.setState(previousApp, true)
  setPoseTable(previousPoses)
})

function controls() {
  const setLookAt = vi.fn().mockResolvedValue(undefined)
  const camera = {
    minDistance: 2.5, maxDistance: 9000, setLookAt,
    getPosition: (out: Vector3) => out.set(70, 100, 70),
    getTarget: (out: Vector3) => out.set(0, 66, 0),
    update: vi.fn(), distance: 110,
  } as unknown as CameraControlsImpl
  registerOrbitControls(camera)
  useApp.setState({ mode: 'orbit' })
  return { move: setLookAt, frame: (delta = 0.1) => updateCameraFlight(camera, delta), finish: () => { for (let frame = 0; frame < 9; frame++) updateCameraFlight(camera, 0.1) } }
}
function subject(position: Vec3) {
  setPoseTable({ index: new Map([['memory', 0]]), pos: new Float32Array(position), born: new Uint8Array([1]) })
}

function viewOf(call: number[]): Vector3 {
  return new Vector3(call[0] - call[3], call[1] - call[4], call[2] - call[5])
}

describe('spatial record inspection', () => {
  it('targets the true XYZ pose and keeps the current viewing direction on either side of the origin', () => {
    const { move, finish } = controls()
    const expectedDirection = new Vector3(70, 34, 70).normalize()
    for (const position of [[-22, 66, 0], [160, 43, -230], [0, 91, 0]] as Vec3[]) {
      subject(position)
      const original = getPoseTable().pos.slice()
      expect(flyTo('memory')).toBe(true)
      finish()
      const call = move.mock.calls.at(-1)!
      expect(call.slice(3, 6)).toEqual(position)
      expect(viewOf(call).length()).toBeCloseTo(16, 6)
      expect(viewOf(call).normalize().distanceTo(expectedDirection)).toBeLessThan(1e-6)
      expect(getPoseTable().pos).toEqual(original)
    }
    // The opposite-side subject is approached from the existing view, not forced radially outward.
    const opposite = move.mock.calls.findLast(call => call[3] === -22)!
    expect(opposite[0]).toBeGreaterThan(opposite[3])
  })

  it('moves the inspection camera with a translated subject without an origin-based bias', () => {
    const { move } = controls()
    subject([-22, 66, 0])
    flyTo('memory', { distance: 32, transition: false })
    const first = move.mock.calls[0]!
    subject([478, 66, -300])
    flyTo('memory', { distance: 32, transition: false })
    const translated = move.mock.calls[1]!
    expect(translated[0] - first[0]).toBeCloseTo(500, 6)
    expect(translated[1] - first[1]).toBeCloseTo(0, 6)
    expect(translated[2] - first[2]).toBeCloseTo(-300, 6)
    expect(translated[6]).toBe(false)
  })

  it('honors explicit inspection directions and distance in the subject’s own space', () => {
    const { move, finish } = controls()
    subject([-22, 66, 15])
    flyTo('memory', { from: [0, .3, -1], distance: 40 })
    finish()
    const call = move.mock.calls.at(-1)!
    expect(call.slice(3, 6)).toEqual([-22, 66, 15])
    expect(call[0]).toBeCloseTo(-22, 8)
    expect(call[1]).toBeGreaterThan(66)
    expect(call[2]).toBeLessThan(15)
    const direction = viewOf(call)
    expect(direction.length()).toBeCloseTo(40, 6)
    expect(direction.normalize().distanceTo(new Vector3(0, .3, -1).normalize())).toBeLessThan(1e-6)
  })
  it('advances a bounded flight and stops applying poses when interrupted', () => {
    const { move, frame } = controls()
    subject([200, 66, -150])
    flyTo('memory')
    expect(move).not.toHaveBeenCalled()
    frame(0.06)
    expect(move).toHaveBeenCalledOnce()
    expect(move.mock.calls[0]![3]).toBeGreaterThan(0)
    expect(move.mock.calls[0]![3]).toBeLessThan(200)
    cancelCameraFlight()
    frame()
    expect(move).toHaveBeenCalledOnce()
  })

  it('moves immediately while scene motion is paused', () => {
    const { move, frame } = controls()
    useApp.setState({ view: { ...useApp.getState().view, flow: false } })
    subject([20, 66, 15])
    flyTo('memory')
    expect(move.mock.calls[0]?.slice(3, 7)).toEqual([20, 66, 15, false])
    frame()
    expect(move).toHaveBeenCalledOnce()
  })

})
