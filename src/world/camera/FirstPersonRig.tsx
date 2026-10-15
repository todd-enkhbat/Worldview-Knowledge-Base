import { useLayoutEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { isTyping } from './keyboard.ts'
import { resetSparkControls, setSparkControlsEnabled, sparkControlsFor } from './sparkControls.ts'

// Generic first-person flight: Spark's SparkControls (WASD/arrows move, Q/E or PgUp/PgDn
// down/up, drag to look, Shift ×5). The single per-canvas instance comes from
// sparkControlsFor(); this component only arms it while first_person is the mode.

export function FirstPersonRig() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const controls = useMemo(() => sparkControlsFor(gl.domElement), [gl])

  // PLAN § Camera: on entering, reset lastTime, clear keys and toggle enable. Spark records
  // input even while disabled, so stale keys/drags are wiped on the way in and on the way out.
  // Layout phase, so the reset precedes the first useFrame tick.
  useLayoutEffect(() => {
    camera.up.set(0, 1, 0)
    resetSparkControls(controls)
    setSparkControlsEnabled(controls, true)
    return () => {
      setSparkControlsEnabled(controls, false)
      resetSparkControls(controls)
    }
  }, [controls, camera])

  // Priority −2 with the other camera writers, before NodeLayer (−1) reads the view.
  useFrame(() => {
    // Spark listens on document, so typing into a HUD field would otherwise fly the camera.
    controls.fpsMovement.enable = !isTyping()
    controls.update(camera)
  }, -2)

  return null
}
