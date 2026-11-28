import type { CameraControlsImpl } from '@react-three/drei'
import { Vector3 } from 'three'
import { useApp } from '../../app/store.ts'
import type { Vec3 } from '../../domain/types.ts'

let media: MediaQueryList | undefined

export function reducedSceneMotion() {
  media ??= globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
  return media?.matches === true
}

export function sceneMotionEnabled(flow = useApp.getState().view.flow) {
  return flow && !reducedSceneMotion()
}

let flight: { start: Vector3; end: Vector3; target: Vector3; destination: Vector3; distance: number; duration: number; elapsed: number } | null = null

export function prefersStillCamera() {
  return !sceneMotionEnabled()
}

export function cancelCameraFlight() {
  flight = null
}

const cameraPosition = new Vector3(), cameraTarget = new Vector3()

/** The camera takes a shallow arc as it searches for a record, then settles on its anchor. */
export function moveOrbitCamera(c: CameraControlsImpl, position: Vec3, target: Vec3, transition = true) {
  cancelCameraFlight()
  if (!transition || prefersStillCamera()) {
    void c.setLookAt(...position, ...target, false)
    return
  }
  const start = c.getPosition(new Vector3(), false), end = new Vector3(...position)
  const startTarget = c.getTarget(new Vector3(), false), destination = new Vector3(...target)
  const distance = Math.max(start.distanceTo(end), startTarget.distanceTo(destination))
  if (distance < 0.01) return
  flight = { start, end, target: startTarget, destination, distance, duration: 0.32 + Math.min(0.48, distance / 550), elapsed: 0 }
}

export function updateCameraFlight(c: CameraControlsImpl, delta: number) {
  if (!flight) return
  const current = flight
  current.elapsed += Number.isFinite(delta) ? Math.max(0, delta) : 0
  const progress = prefersStillCamera() ? 1 : Math.min(1, current.elapsed / current.duration)
  const eased = 1 - (1 - progress) ** 3
  cameraPosition.lerpVectors(current.start, current.end, eased)
  cameraPosition.y += Math.sin(Math.PI * eased) ** 2 * Math.min(27, current.distance * 0.1)
  cameraTarget.lerpVectors(current.target, current.destination, eased)
  void c.setLookAt(cameraPosition.x, cameraPosition.y, cameraPosition.z, cameraTarget.x, cameraTarget.y, cameraTarget.z, false)
  c.update(0)
  if (progress === 1) cancelCameraFlight()
}
