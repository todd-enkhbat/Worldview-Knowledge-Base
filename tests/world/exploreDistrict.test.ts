import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import { useApp } from '../../src/app/store.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { flyTo, getOrbitControls } from '../../src/world/camera/flyTo.ts'
import { buildSpatialGround } from '../../src/world/environment/knowledgeGround.ts'
import { districtFraming, exploreDistrict } from '../../src/world/environment/exploreDistrict.ts'

vi.mock('../../src/world/camera/flyTo.ts', () => ({ flyTo: vi.fn(() => true), getOrbitControls: vi.fn(() => null) }))
const original = useApp.getState()
afterEach(() => { useApp.setState(original, true); vi.clearAllMocks(); vi.mocked(getOrbitControls).mockReset() })

describe('exploring a neighborhood', () => {
  it('frames the actual cluster volume and clears note inspection without choosing an arbitrary record', () => {
    const note = makeNodeDraft('memory', { id: 'memory', tags: ['memory'] })
    const world = computeSpatialWorld([note])
    const plan = buildSpatialGround(world, [note]), district = plan.districts[0]
    useApp.getState().select(note.id)
    expect(exploreDistrict(plan, district)).toBe(true)
    expect(useApp.getState().selectedId).toBeNull()
    expect(useApp.getState().panels.inspector).toBe(false)
    const framing = districtFraming(world.clusters[0])
    expect(flyTo).toHaveBeenCalledWith(world.clusters[0].bounds.center, { distance: framing.distance })
    expect(framing.distance).toBeGreaterThanOrEqual(180)
    expect(vi.mocked(flyTo).mock.calls[0][1]?.from).toBeUndefined()
  })

  it('uses the live orbit camera aspect and effective FOV for narrow viewports', () => {
    const note = makeNodeDraft('idea', { id: 'a', tags: ['thermodynamics'] })
    const world = computeSpatialWorld([note]), plan = buildSpatialGround(world, [note])
    const camera = new PerspectiveCamera(50, .4, .1, 10000)
    camera.zoom = 1.2
    vi.mocked(getOrbitControls).mockReturnValue({ camera } as CameraControlsImpl)
    exploreDistrict(plan, plan.districts[0])
    const framing = districtFraming(world.clusters[0], camera.getEffectiveFOV(), camera.aspect)
    expect(flyTo).toHaveBeenCalledWith(framing.target, { distance: framing.distance })
    expect(framing.distance).toBeGreaterThan(districtFraming(world.clusters[0]).distance)
  })

  it('fits every actual note and its molecular packet from oblique views in landscape and portrait', () => {
    const notes = Array.from({ length: 16 }, (_, i) => makeNodeDraft('idea', { id: `thermo-${i}`, tags: ['thermodynamics'] }))
    const world = computeSpatialWorld(notes), cluster = world.clusters[0]
    for (const aspect of [.4, 1.5]) for (const fov of [40, 50, 65]) {
      const framing = districtFraming(cluster, fov, aspect)
      for (const direction of [[-1, .5, .2], [.6, .15, 1], [.2, .95, -.4]]) {
        const camera = new PerspectiveCamera(fov, aspect, .1, 10000)
        const target = new Vector3(...framing.target)
        camera.position.copy(target).addScaledVector(new Vector3(...direction).normalize(), framing.distance)
        camera.lookAt(target)
        camera.updateMatrixWorld()
        for (const id of cluster.memberIds) for (let sample = 0; sample < 32; sample++) {
          const y = 1 - (sample + .5) / 16, angle = sample * Math.PI * (3 - Math.sqrt(5)), flat = Math.sqrt(1 - y * y)
          const point = new Vector3(...world.positions.get(id)!).addScaledVector(new Vector3(Math.cos(angle) * flat, y, Math.sin(angle) * flat), 42)
          point.project(camera)
          expect(Math.abs(point.x)).toBeLessThan(1)
          expect(Math.abs(point.y)).toBeLessThan(1)
          expect(point.z).toBeGreaterThan(-1)
          expect(point.z).toBeLessThan(1)
        }
      }
    }
  })
})
