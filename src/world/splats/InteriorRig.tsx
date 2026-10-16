import { useLayoutEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { isTyping } from '../camera/keyboard.ts'
import { resetSparkControls, setSparkControlsEnabled, sparkControlsFor } from '../camera/sparkControls.ts'
import { getDiorama } from './Diorama.tsx'
import { currentFlight } from './FlyInRig.tsx'
import { FLIGHT, setWorldHidden } from './flyIn.ts'

// Inside a diorama ('interior'): the world group is hidden and the canvas's single
// SparkControls flies the camera with 6 DOF + roll (Z / C keys, two-finger twist). Esc goes
// through useApp.escape() → 'exiting', which FlyInRig plays back.

/**
 * Hide the world group (environment, nodes, links, dust) and suspend R3F pointer events while
 * mounted. R3F raycasts invisible objects too, so without the second step a double-click in
 * the interior would hit a hidden tesseract behind it and start another fly-in.
 */
export function useWorldHidden(): void {
  const scene = useThree((s) => s.scene)
  const setEvents = useThree((s) => s.setEvents)
  const get = useThree((s) => s.get)
  useLayoutEffect(() => {
    const wasEnabled = get().events.enabled
    setWorldHidden(scene, true)
    setEvents({ enabled: false })
    return () => {
      setWorldHidden(scene, false)
      setEvents({ enabled: wasEnabled })
      document.body.style.cursor = ''
    }
  }, [scene, setEvents, get])
}

const ROLL_KEYS = { KeyZ: new Vector3(0, 0, 1), KeyC: new Vector3(0, 0, -1) }

export function InteriorRig() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const controls = useMemo(() => sparkControlsFor(gl.domElement), [gl])

  useWorldHidden()

  // Layout phase so the reset lands before the first useFrame tick (PLAN § Camera: reset
  // lastTime, clear keys, toggle enable).
  useLayoutEffect(() => {
    camera.up.set(0, 1, 0)
    const fps = controls.fpsMovement
    const pointer = controls.pointerControls
    const saved = { moveSpeed: fps.moveSpeed, rotate: fps.keycodeRotateMapping, roll: pointer.pointerRollScale }
    // Native units per second, scaled by how big the interior is drawn.
    const inst = getDiorama(currentFlight()?.id)
    const unitsPerNative = inst ? inst.worldPerNative() : FLIGHT.interiorUnitsPerNative
    fps.moveSpeed = FLIGHT.interiorMoveSpeed * unitsPerNative
    fps.keycodeRotateMapping = { ...saved.rotate, ...ROLL_KEYS }
    pointer.pointerRollScale = 1
    resetSparkControls(controls)
    setSparkControlsEnabled(controls, true)
    return () => {
      setSparkControlsEnabled(controls, false)
      resetSparkControls(controls)
      fps.moveSpeed = saved.moveSpeed
      fps.keycodeRotateMapping = saved.rotate
      pointer.pointerRollScale = saved.roll
    }
  }, [controls, camera])

  // Priority −2 with the other camera writers.
  useFrame(() => {
    // Spark listens on document, so typing into a HUD field would otherwise fly the camera.
    controls.fpsMovement.enable = !isTyping()
    controls.update(camera)
  }, -2)

  return null
}
