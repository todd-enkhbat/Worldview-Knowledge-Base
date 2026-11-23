// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import CameraControls from 'camera-controls'
import * as THREE from 'three'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { applyOrbitGroundClearance, ORBIT_GROUND_CLEARANCE } from '../../src/world/camera/OrbitRig.tsx'
import { buildSpatialGround, groundYAt } from '../../src/world/environment/knowledgeGround.ts'

CameraControls.install({ THREE })

function fixture() {
  const notes = [
    makeNodeDraft('idea', { id: 'science', tags: ['science'], links: [{ targetId: 'design', kind: 'relates', createdAt: 1 }] }),
    makeNodeDraft('idea', { id: 'design', tags: ['design'] }),
  ]
  const ground = buildSpatialGround(computeSpatialWorld(notes), notes)
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 10000)
  const controls = new CameraControls(camera)
  return { ground, camera, controls }
}

describe('orbit clearance over shared semantic ground', () => {
  it('lifts out of raised districts and real-link ramps while retaining its pivot and XZ', () => {
    const { ground, camera, controls } = fixture()
    const district = ground.districts[0]
    const corridor = ground.corridors[0]
    const samples = [[district.x, district.z], [(corridor.ax + corridor.bx) / 2, (corridor.az + corridor.bz) / 2]]
    for (const [x, z] of samples) {
      const surface = groundYAt(ground, x, z)
      expect(surface).toBeGreaterThan(0)
      const pivot = new THREE.Vector3(x + 25, surface + 20, z + 15)
      void controls.setLookAt(x, surface - 5, z, ...pivot.toArray(), false)
      controls.update(0)
      applyOrbitGroundClearance(controls, ground)
      expect(camera.position.x).toBeCloseTo(x, 8)
      expect(camera.position.z).toBeCloseTo(z, 8)
      expect(camera.position.y).toBeCloseTo(surface + ORBIT_GROUND_CLEARANCE, 8)
      expect(controls.getTarget(new THREE.Vector3(), false).distanceTo(pivot)).toBeLessThan(1e-8)
      for (let frame = 0; frame < 30; frame++) {
        controls.update(1 / 60)
        applyOrbitGroundClearance(controls, ground)
        expect(camera.position.y).toBeGreaterThanOrEqual(surface + ORBIT_GROUND_CLEARANCE - 1e-7)
      }
    }
    controls.dispose()
  })

  it('keeps a clear orbit unchanged and still protects the datum outside all districts', () => {
    const { ground, camera, controls } = fixture()
    void controls.setLookAt(3000, 90, 3000, 2900, 40, 2900, false)
    controls.update(0)
    const before = camera.position.clone()
    applyOrbitGroundClearance(controls, ground)
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-8)
    void controls.setLookAt(3000, -8, 3000, 2900, 40, 2900, false)
    controls.update(0)
    applyOrbitGroundClearance(controls, ground)
    expect(camera.position.y).toBeCloseTo(ORBIT_GROUND_CLEARANCE, 8)
    controls.dispose()
  })
})
