import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3, type Group, type PointLight } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { spatialWorldFor } from '../field/layout.ts'
import { groundYAt, spatialGroundFor } from '../environment/knowledgeGround.ts'
import { AvatarFigure } from './AvatarRig.tsx'
import { lastOrbitTarget, setOrbitHandoff } from './flyTo.ts'
import { isEditableTarget } from './keyboard.ts'
import { updateProximity } from './proximity.ts'

/** Walk speed is spatial units per real second, independent of history playback. */
export const WALK_SPEED = 13
export const RUN_SPEED = 32
const HEAD = 1.7
const walker = { pos: new Vector3(), placed: false, bodyYaw: 0, yaw: .7, pitch: .2, distance: 38, look: new Vector3() }

export function walkStep(
  point: { x: number; y: number; z: number }, forward: number, side: number, yaw: number,
  dt: number, running: boolean, ground: (x: number, z: number) => number,
  bounds: { min: readonly number[]; max: readonly number[] },
): void {
  const length = Math.hypot(forward, side)
  if (length > 0) {
    const step = (running ? RUN_SPEED : WALK_SPEED) * Math.min(.1, Math.max(0, dt)) / Math.max(1, length)
    point.x += (-Math.sin(yaw) * forward + Math.cos(yaw) * side) * step
    point.z += (-Math.cos(yaw) * forward - Math.sin(yaw) * side) * step
  }
  point.x = Math.max(bounds.min[0]! - 65, Math.min(bounds.max[0]! + 65, point.x))
  point.z = Math.max(bounds.min[2]! - 65, Math.min(bounds.max[2]! + 65, point.z))
  point.y = ground(point.x, point.z)
}

/** A free ground walker across real topic regions; there is no central track or time height. */
export function SpatialWalkRig() {
  const nodes = useWorld((s) => s.nodes)
  const world = useMemo(() => spatialWorldFor(nodes), [nodes])
  const ground = useMemo(() => spatialGroundFor(nodes), [nodes])
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const figure = useRef<Group>(null)
  const keys = useRef(new Set<string>())
  const desired = useMemo(() => new Vector3(), [])
  const goal = useMemo(() => new Vector3(), [])
  const entered = useRef(true)
  const initial = useRef({ world, ground })

  useLayoutEffect(() => {
    const { world: entryWorld, ground: entryGround } = initial.current
    walker.pos.set(lastOrbitTarget.x, 0, lastOrbitTarget.z)
    // An empty/invalid pivot enters at the nearest real district, rather than a stale tower.
    if (!Number.isFinite(walker.pos.x + walker.pos.z)) walker.pos.set(entryWorld.bounds.center[0], 0, entryWorld.bounds.center[2])
    const district = [...entryWorld.clusters].sort((a, b) => Math.hypot(a.center[0] - walker.pos.x, a.center[2] - walker.pos.z) - Math.hypot(b.center[0] - walker.pos.x, b.center[2] - walker.pos.z))[0]
    if (district && Math.hypot(district.center[0] - walker.pos.x, district.center[2] - walker.pos.z) > district.radius)
      walker.pos.set(district.center[0], 0, district.center[2])
    walker.pos.y = groundYAt(entryGround, walker.pos.x, walker.pos.z)
    walker.yaw = Math.atan2(camera.position.x - walker.pos.x, camera.position.z - walker.pos.z)
    walker.placed = true
    camera.getWorldDirection(walker.look).multiplyScalar(16).add(camera.position)
    entered.current = true
    return () => { setOrbitHandoff(walker.look); walker.placed = false }
  }, [camera])

  useEffect(() => {
    const held = keys.current
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      held.add(event.code)
      if (event.code.startsWith('Arrow')) event.preventDefault()
    }
    const up = (event: KeyboardEvent) => { held.delete(event.code) }
    const clear = () => held.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); clear() }
  }, [])

  useEffect(() => {
    const canvas = gl.domElement
    let dragging = false, px = 0, py = 0
    const down = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return
      dragging = true; px = event.clientX; py = event.clientY
    }
    const move = (event: PointerEvent) => {
      if (!dragging) return
      walker.yaw -= (event.clientX - px) * .006
      walker.pitch = Math.max(-1.1, Math.min(1.1, walker.pitch + (event.clientY - py) * .004))
      px = event.clientX; py = event.clientY
    }
    const up = () => { dragging = false }
    const wheel = (event: WheelEvent) => { walker.distance = Math.max(7, Math.min(80, walker.distance * Math.exp(event.deltaY * .001))); event.preventDefault() }
    const context = (event: MouseEvent) => event.preventDefault()
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('contextmenu', context)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('contextmenu', context)
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
    }
  }, [gl])

  useFrame((_, delta) => {
    const dt = Math.min(delta, .1)
    const held = keys.current
    const forward = Number(held.has('KeyW') || held.has('ArrowUp')) - Number(held.has('KeyS') || held.has('ArrowDown'))
    const side = Number(held.has('KeyD') || held.has('ArrowRight')) - Number(held.has('KeyA') || held.has('ArrowLeft'))
    const beforeX = walker.pos.x, beforeZ = walker.pos.z
    walkStep(walker.pos, forward, side, walker.yaw, dt, held.has('ShiftLeft') || held.has('ShiftRight'), (x, z) => groundYAt(ground, x, z), world.bounds)
    const k = 1 - Math.exp(-dt / .16)
    if (forward || side) {
      const yaw = Math.atan2(walker.pos.x - beforeX, walker.pos.z - beforeZ)
      walker.bodyYaw += Math.atan2(Math.sin(yaw - walker.bodyYaw), Math.cos(yaw - walker.bodyYaw)) * k
    }
    if (figure.current) { figure.current.position.copy(walker.pos); figure.current.rotation.y = walker.bodyYaw }
    const horizontal = Math.cos(walker.pitch) * walker.distance
    desired.set(walker.pos.x + Math.sin(walker.yaw) * horizontal, walker.pos.y + HEAD + Math.sin(walker.pitch) * walker.distance, walker.pos.z + Math.cos(walker.yaw) * horizontal)
    desired.y = Math.max(desired.y, groundYAt(ground, desired.x, desired.z) + 1.8)
    goal.copy(walker.pos); goal.y += HEAD + 7 + Math.max(0, -walker.pitch) * 100
    const smooth = 1 - Math.exp(-dt / (entered.current ? .6 : .16))
    camera.position.lerp(desired, smooth)
    walker.look.lerp(goal, smooth)
    if (camera.position.distanceToSquared(desired) < .2) entered.current = false
    camera.up.set(0, 1, 0)
    camera.lookAt(walker.look)
    updateProximity(walker.pos.x, walker.pos.y + HEAD, walker.pos.z)
  }, -2)
  return <AvatarFigure ref={figure} />
}

/** Mounted continuously so changing camera mode does not add/remove a lighting program. */
export function SpatialWalkLamp() {
  const lamp = useRef<PointLight>(null)
  useFrame((_, dt) => {
    const light = lamp.current
    if (!light) return
    const target = useApp.getState().mode === 'third_person' && walker.placed ? 5 : 0
    light.intensity += (target - light.intensity) * (1 - Math.exp(-Math.min(dt, .1) / .25))
    light.position.copy(walker.pos); light.position.y += HEAD
  })
  return <pointLight ref={lamp} color="#bddbea" intensity={0} distance={12} decay={2} />
}
