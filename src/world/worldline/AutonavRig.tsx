import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { canTransition, useApp } from '../../app/store.ts'
import { setOrbitHandoff } from '../camera/flyTo.ts'
import { AutonavRide, type AutonavOptions } from './autonav.ts'
import { refreshWorldline } from './live.ts'

// The camera rig for mode 'autonav' (mounted by CameraRig): rides the live worldline from
// the earliest memory to the latest, then hands back. It is the camera's only writer while
// mounted (CameraControls is unmounted in this mode). Esc goes through useApp.escape(),
// which returns to the previous mode; whoever takes over gets the point we were looking at
// as the orbit pivot.

/** Seconds to hold on the last memory before handing back. */
const END_HOLD = 1.5
/** A worldline needs two memories; give the path this long to appear (poses arrive async). */
const NO_PATH_GRACE = 0.75

/** Leave autonav for the previous mode (or orbit), like Esc. */
export function exitAutonav(): void {
  const s = useApp.getState()
  if (s.mode !== 'autonav') return
  const back = s.prevMode !== 'autonav' && canTransition('autonav', s.prevMode) ? s.prevMode : 'orbit'
  s.setMode(back)
}

export interface AutonavRigProps {
  options?: Partial<AutonavOptions>
}

export function AutonavRig({ options }: AutonavRigProps) {
  const camera = useThree((s) => s.camera)
  const ride = useMemo(() => new AutonavRide(options), [options])
  const held = useRef(0)
  const empty = useRef(0)

  useLayoutEffect(() => {
    const dir = camera.getWorldDirection(new Vector3())
    ride.prime(camera.position, dir.multiplyScalar(20).add(camera.position))
    held.current = 0
    empty.current = 0
    // Runs before the next rig's layout mount (OrbitRig takes the pivot there).
    return () => setOrbitHandoff(ride.look)
  }, [camera, ride])

  // After the pose writer (−2), with the worldline ribbon (−1).
  useFrame((_, dt) => {
    const path = refreshWorldline()
    if (path.count < 2) {
      empty.current += dt
      if (empty.current > NO_PATH_GRACE) exitAutonav()
      return
    }
    empty.current = 0
    const riding = ride.update(dt, path)
    camera.position.set(ride.camera.x, ride.camera.y, ride.camera.z)
    camera.lookAt(ride.look.x, ride.look.y, ride.look.z)
    if (!riding) {
      held.current += dt
      if (held.current > END_HOLD) exitAutonav()
    }
  }, -1)

  return null
}
