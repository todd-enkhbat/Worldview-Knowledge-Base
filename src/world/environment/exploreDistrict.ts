import { useApp } from '../../app/store.ts'
import type { SpatialCluster } from '../../domain/spatial.ts'
import type { Vec3 } from '../../domain/types.ts'
import { flyTo, getOrbitControls } from '../camera/flyTo.ts'
import type { GroundDistrict, SpatialGroundPlan } from './knowledgeGround.ts'

/** A sphere fit remains valid from the viewer's current direction, including portrait. */
export function districtFraming(cluster: SpatialCluster, fov = 50, aspect = 1.6): { target: Vec3; distance: number } {
  const vertical = Math.min(160, Math.max(10, fov)) * Math.PI / 360
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(.1, aspect))
  // The bounds enclose actual XYZ members; packets extend beyond their note anchors.
  const radius = Math.max(cluster.bounds.radius, cluster.radius) + 42
  return {
    target: [...cluster.bounds.center],
    distance: Math.max(180, radius / Math.sin(Math.min(vertical, horizontal)) * 1.08),
  }
}

/** A neighborhood click frames its actual volume; individual notes retain inspection. */
export function exploreDistrict(plan: SpatialGroundPlan, district: GroundDistrict): boolean {
  const cluster = plan.world.clusters.find((cluster) => cluster.id === district.id)
  if (!cluster) return false
  const camera = getOrbitControls()?.camera
  const framing = districtFraming(cluster, camera && 'fov' in camera ? camera.getEffectiveFOV() : 50, camera && 'aspect' in camera ? camera.aspect : 1.6)
  useApp.getState().select(null)
  return flyTo(framing.target, { distance: framing.distance })
}
