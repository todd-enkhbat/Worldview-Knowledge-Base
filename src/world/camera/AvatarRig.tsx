import { useEffect, useLayoutEffect, useRef, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { easing } from 'maath'
import { Color, Vector3, type Group, type PointLight } from 'three'
import { useApp } from '../../app/store.ts'
import { CORE_RADIUS, HELIX } from '../../domain/placement.ts'
import { LAYER } from '../layers.ts'
import { avatar, placeAvatar, rebindAvatar, stepAvatar, type AvatarInput } from './avatar.ts'
import { lastOrbitTarget, setOrbitHandoff } from './flyTo.ts'
import { isEditableTarget } from './keyboard.ts'
import { updateProximity } from './proximity.ts'
import type { WalkGraph } from './walkGraph.ts'

// Third person: the kinematic walker on the catwalk and its damped follow camera.
// W/S ↑/↓ walk the helix (up = later in time), A/D ←/→ step onto/off a spur near its
// attachment, Shift runs; drag orbits the camera around the walker, wheel zooms.
// Movement + camera run at useFrame priority −2, before NodeLayer (−1) reads poses.

const HEAD = 1.7
const DIST_MIN = 3
const DIST_MAX = 40
const PITCH_MIN = -0.1
const PITCH_MAX = 1.25
/** Keep the follow camera outside the concrete core. */
const CORE_CLEAR = CORE_RADIUS + 1.2

// Follow-camera state survives remounts, like the walker itself.
const follow = {
  bodyYaw: 0,
  camYaw: 0,
  userYaw: 0,
  pitch: 0.32,
  distance: 7.5,
  /** 1 right after entering third person: slower damping so the cut from orbit is a glide. */
  settle: 1,
  dragging: false,
  look: new Vector3(),
}

const keys: Record<string, boolean> = {}
let sidePressed = false
const input: AvatarInput = { move: 0, run: false, side: false }

const desired = new Vector3()
const lookGoal = new Vector3()

export function AvatarRig({ graph }: { graph: WalkGraph }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const group = useRef<Group>(null)
  const boundGraph = useRef<WalkGraph | null>(null)

  // Keyboard: own key state (not Spark's, which keeps recording in every mode).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (!keys[e.code] && (e.code === 'KeyA' || e.code === 'KeyD' || e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        sidePressed = true
      }
      keys[e.code] = true
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') e.preventDefault()
    }
    const up = (e: KeyboardEvent) => {
      keys[e.code] = false
    }
    const clear = () => {
      for (const k in keys) keys[k] = false
      sidePressed = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [])

  // Pointer: drag orbits around the walker, wheel zooms.
  useEffect(() => {
    const el = gl.domElement
    let lastX = 0
    let lastY = 0
    let id = -1
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return
      follow.dragging = true
      id = e.pointerId
      lastX = e.clientX
      lastY = e.clientY
    }
    const onMove = (e: PointerEvent) => {
      if (!follow.dragging || e.pointerId !== id) return
      follow.userYaw -= (e.clientX - lastX) * 0.006
      follow.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, follow.pitch + (e.clientY - lastY) * 0.004))
      lastX = e.clientX
      lastY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === id) follow.dragging = false
    }
    const onWheel = (e: WheelEvent) => {
      follow.distance = Math.min(DIST_MAX, Math.max(DIST_MIN, follow.distance * Math.exp(e.deltaY * 0.001)))
      e.preventDefault()
    }
    const onContext = (e: MouseEvent) => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('contextmenu', onContext)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('contextmenu', onContext)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
      follow.dragging = false
    }
  }, [gl])

  // Entering third person: glide from wherever the camera is. Coming from orbit, a walker
  // left more than a turn away from the orbit target is re-placed at the target's height, so
  // T drops you where you were looking rather than where you last walked. Leaving hands the
  // look point to the orbit rig as its pivot. Layout phase: OrbitRig's own layout mount
  // reads the handoff, so the cleanup must run before it (deletion cleanups do).
  useLayoutEffect(() => {
    follow.settle = 1
    camera.getWorldDirection(follow.look).multiplyScalar(10).add(camera.position)
    if (avatar.placed && useApp.getState().prevMode === 'orbit' && Math.abs(lastOrbitTarget.y - avatar.pos.y) > HELIX.pitch) {
      avatar.placed = false
    }
    return () => setOrbitHandoff(follow.look)
  }, [camera])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1)
    const a = avatar
    if (!a.placed) {
      placeAvatar(a, graph, lastOrbitTarget.y)
      follow.bodyYaw = follow.camYaw = Math.atan2(a.facing.x, a.facing.z)
    } else if (boundGraph.current !== graph) {
      rebindAvatar(a, graph)
    }
    boundGraph.current = graph

    input.move = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0)
    input.run = !!(keys.ShiftLeft || keys.ShiftRight)
    input.side = sidePressed
    sidePressed = false
    stepAvatar(a, graph, input, dt)

    const yaw = Math.atan2(a.facing.x, a.facing.z)
    easing.dampAngle(follow, 'bodyYaw', yaw, 0.1, dt)
    easing.dampAngle(follow, 'camYaw', yaw, 0.55, dt)
    if (a.moving && !follow.dragging) easing.damp(follow, 'userYaw', 0, 1.2, dt)
    follow.settle = Math.max(0, follow.settle - dt * 1.2)

    const g = group.current
    if (g) {
      g.position.copy(a.pos)
      g.rotation.y = follow.bodyYaw
    }

    // Behind the walker (yaw + π), raised by the pitch.
    const cy = follow.camYaw + follow.userYaw + Math.PI
    const cp = Math.cos(follow.pitch)
    desired.set(
      a.pos.x + Math.sin(cy) * cp * follow.distance,
      a.pos.y + HEAD + Math.sin(follow.pitch) * follow.distance,
      a.pos.z + Math.cos(cy) * cp * follow.distance,
    )
    const r = Math.hypot(desired.x, desired.z)
    if (r < CORE_CLEAR && r > 1e-6) {
      desired.x *= CORE_CLEAR / r
      desired.z *= CORE_CLEAR / r
    }
    lookGoal.set(a.pos.x + a.facing.x * 1.5, a.pos.y + HEAD * 0.75, a.pos.z + a.facing.z * 1.5)
    const smooth = 0.16 + 0.55 * follow.settle
    easing.damp3(camera.position, desired, smooth, dt)
    easing.damp3(follow.look, lookGoal, smooth * 0.7, dt)
    camera.lookAt(follow.look)

    updateProximity(a.pos.x, a.pos.y + HEAD * 0.5, a.pos.z)
  }, -2)

  return <AvatarFigure ref={group} />
}

// ─── the figure ──────────────────────────────────────────────────────────────────────
// A chrome obelisk on a brass plinth with a floating ember pyramidion: Boullée in miniature.
// Solid geometry, so it lives on LAYER.SOLID and shows in the floor reflection. R3F disposes
// the JSX geometries/materials on unmount.

const CHROME = '#cfd2d4'
const BRASS = '#c9973f'
// HDR emissive (×6 / ×4 over the sRGB token, in linear) so threshold Bloom picks them up;
// toneMapped off keeps them hot.
const EMBER_HDR = new Color('#e8b04a').multiplyScalar(6)
const SIGNAL_HDR = new Color('#ff4a1c').multiplyScalar(4)

function AvatarFigure({ ref }: { ref: Ref<Group> }) {
  return (
    <group ref={ref}>
      {/* plinth */}
      <mesh position={[0, 0.06, 0]} layers={LAYER.SOLID}>
        <boxGeometry args={[0.62, 0.12, 0.62]} />
        <meshStandardMaterial color={BRASS} metalness={1} roughness={0.38} />
      </mesh>
      {/* shaft: a four-sided tapered prism turned square to the facing */}
      <mesh position={[0, 0.84, 0]} rotation={[0, Math.PI / 4, 0]} layers={LAYER.SOLID}>
        <cylinderGeometry args={[0.16, 0.3, 1.44, 4, 1]} />
        <meshStandardMaterial color={CHROME} metalness={1} roughness={0.14} flatShading />
      </mesh>
      {/* brass collar */}
      <mesh position={[0, 1.18, 0]} layers={LAYER.SOLID}>
        <boxGeometry args={[0.3, 0.06, 0.3]} />
        <meshStandardMaterial color={BRASS} metalness={1} roughness={0.3} />
      </mesh>
      {/* signal sliver on the front face: reads the heading */}
      <mesh position={[0, 0.9, 0.17]} layers={LAYER.SOLID}>
        <boxGeometry args={[0.04, 0.5, 0.04]} />
        <meshBasicMaterial color={SIGNAL_HDR} toneMapped={false} />
      </mesh>
      {/* ember pyramidion, floating */}
      <mesh position={[0, 1.78, 0]} layers={LAYER.SOLID}>
        <octahedronGeometry args={[0.15, 0]} />
        <meshBasicMaterial color={EMBER_HDR} toneMapped={false} />
      </mesh>
    </group>
  )
}

// ─── the lamp ────────────────────────────────────────────────────────────────────────
// The walker's soft ember light. Mounted for the life of the rig (not with the figure) and
// faded to zero outside third person: adding or removing a light changes the scene's light
// count, which makes three recompile every lit material, a visible hitch on each T press.

const LAMP_INTENSITY = 7

export function AvatarLamp() {
  const light = useRef<PointLight>(null)
  useFrame((_, delta) => {
    const l = light.current
    if (!l) return
    const on = useApp.getState().mode === 'third_person' && avatar.placed
    easing.damp(l, 'intensity', on ? LAMP_INTENSITY : 0, on ? 0.35 : 0.15, Math.min(delta, 0.1))
    l.position.set(avatar.pos.x, avatar.pos.y + 1.8, avatar.pos.z)
  })
  return <pointLight ref={light} color="#e8b04a" intensity={0} distance={9} decay={2} />
}
