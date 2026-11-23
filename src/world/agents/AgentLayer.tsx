import { useMemo, useRef } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Euler, Object3D, Quaternion, Vector3, type Group, type InstancedMesh } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { spatialWorldFor } from '../field/layout.ts'
import { getPoseTable } from '../poses.ts'
import { openAgentsPanel, queryAgents, type QueryAgent } from './model.ts'
import { advanceAgentTime, agentBodyScale, agentPresentationOffset, sampleAgentPresentation, smoothAgentOffset, type AgentOverlayBox, type AgentScreenPoint } from './presentation.ts'
import './AgentLayer.css'

const TRAIL = 18
const GUIDE_ID = 'world-guide-ui'
type ScreenRegistry = Map<number, AgentScreenPoint & { frame: number }>

function stopPointer(event: ThreeEvent<PointerEvent | MouseEvent>) {
  event.stopPropagation()
  // FieldPicker also owns a native pointerup listener on the same canvas.
  event.nativeEvent.stopImmediatePropagation()
}

function AgentAvatar({ agent, guideRoute, guideHome, onOpen, screenPositions, index = 0 }: { agent?: QueryAgent; guideRoute?: string[]; guideHome?: readonly [number, number, number]; onOpen: () => void; screenPositions: ScreenRegistry; index?: number }) {
  const body = useRef<Group>(null)
  const orbit = useRef<Group>(null)
  const fins = useRef<Group>(null)
  const trail = useRef<InstancedMesh>(null)
  const label = useRef<HTMLButtonElement>(null)
  const elapsed = useRef(index * 2.3)
  const overlays = useRef<{ at: number; version: number; boxes: AgentOverlayBox[] }>({ at: -Infinity, version: 0, boxes: [] })
  const avoidance = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, initialized: false, moving: false, externalSettling: false })
  const environment = useRef({ matrix: [] as number[], width: 0, height: 0, fov: 0, overlays: -1 })
  const scratch = useMemo(() => ({ point: new Vector3(), previous: new Vector3(), home: new Vector3(), target: new Vector3(), clearance: new Vector3(), inverseCamera: new Quaternion(), heading: new Euler(), object: new Object3D() }), [])
  const guide = !agent
  const active = guide || agent.active
  const title = guide ? 'World guide' : `${agent.record.title} agent`
  const tint = guide ? '#91d6e1' : '#e8bd77'
  const shell = guide ? '#69b7c5' : '#e4d7c0'
  const route = guide ? guideRoute ?? [] : active ? agent.route : []

  useFrame((state, delta) => {
    if (!body.current) return
    const app = useApp.getState()
    const poses = getPoseTable()
    const hidden = ['entering', 'interior', 'exiting', 'framing'].includes(app.mode)
    let visible = !hidden
    if (agent) {
      const row = poses.index.get(agent.record.id)
      visible &&= row !== undefined && poses.born[row] === 1
      if (row !== undefined) { scratch.home.fromArray(poses.pos, row * 3); scratch.home.y += 10 }
    } else {
      scratch.home.fromArray(guideHome ?? [18, 20, 0])
    }
    body.current.visible = visible
    if (label.current) label.current.style.display = visible ? '' : 'none'
    if (!visible) { screenPositions.delete(index); if (trail.current) trail.current.count = 0; return }
    elapsed.current = advanceAgentTime(elapsed.current, delta, app.view.flow, active)
    const t = elapsed.current
    const visits = sampleAgentPresentation(route, poses, t, scratch.home, index, scratch.point)
    // Companions remain in the actual 3-D neighborhood they inspect. A bounded local
    // orbit separates scouts without teleporting them into screen-space presentation rows.
    const compact = state.size.width < 660
    const depth = Math.max(1, -scratch.target.copy(scratch.point).applyMatrix4(state.camera.matrixWorldInverse).z)
    const fov = 'fov' in state.camera ? Number(state.camera.fov) : 50
    const unitsPerPixel = 2 * Math.tan(fov * Math.PI / 360) * depth / state.size.height
    // Reminders remain visible. Read their real bounds rather than hiding or dismissing them.
    if (state.clock.elapsedTime - overlays.current.at > .2) {
      overlays.current.at = state.clock.elapsedTime
      const canvas = state.gl.domElement.getBoundingClientRect()
      const boxes = [...document.querySelectorAll('.world-banners')].flatMap((el) => {
        const box = el.getBoundingClientRect()
        return box.width > 0 && box.height > 0 ? [[box.left - canvas.left, box.top - canvas.top, box.right - canvas.left, box.bottom - canvas.top] as AgentOverlayBox] : []
      })
      if (boxes.length !== overlays.current.boxes.length || boxes.some((box, i) => box.some((value, j) => value !== overlays.current.boxes[i]?.[j]))) overlays.current.version++
      overlays.current.boxes = boxes
    }
    scratch.target.copy(scratch.point).project(state.camera)
    const projected = { x: (scratch.target.x * .5 + .5) * state.size.width, y: (-scratch.target.y * .5 + .5) * state.size.height, captionWidth: label.current?.offsetWidth ?? 100 }
    const preceding = [...screenPositions].filter(([order, position]) => order < index && position.frame === state.clock.elapsedTime).map(([, position]) => position)
    const offset = avoidance.current
    const target = agentPresentationOffset(projected, preceding, overlays.current.boxes, state.size.height, 180 / unitsPerPixel, { x: offset.x / unitsPerPixel, y: offset.y / unitsPerPixel })
    const view = environment.current
    const changed = view.width !== state.size.width || view.height !== state.size.height || view.fov !== fov || view.overlays !== overlays.current.version || state.camera.matrixWorld.elements.some((value, i) => value !== view.matrix[i])
    if (changed) environment.current = { matrix: [...state.camera.matrixWorld.elements], width: state.size.width, height: state.size.height, fov, overlays: overlays.current.version }
    const moving = app.view.flow && active
    if (!offset.initialized) {
      // Resolve the first visible placement before drawing, then ease subsequent changes.
      offset.x = target.x * unitsPerPixel; offset.y = target.y * unitsPerPixel
      offset.initialized = true
    }
    if (moving || changed) {
      offset.targetX = target.x * unitsPerPixel; offset.targetY = target.y * unitsPerPixel
      offset.externalSettling = !moving && changed
    } else if (offset.moving) {
      // Pausing cancels an unfinished route correction exactly where it is.
      offset.externalSettling = false
    }
    const eased = smoothAgentOffset(offset, { x: offset.targetX, y: offset.targetY }, delta, moving || offset.externalSettling)
    offset.x = eased.x; offset.y = eased.y; offset.moving = moving
    if (Math.hypot(offset.x - offset.targetX, offset.y - offset.targetY) < .01) offset.externalSettling = false
    const shift = { x: offset.x / unitsPerPixel, y: offset.y / unitsPerPixel }
    screenPositions.set(index, { ...projected, x: projected.x + shift.x, y: projected.y + shift.y, frame: state.clock.elapsedTime })
    scratch.clearance.set(shift.x * unitsPerPixel, -shift.y * unitsPerPixel, 0).applyQuaternion(state.camera.quaternion)
    body.current.position.copy(scratch.point).add(scratch.clearance)
    body.current.scale.setScalar(agentBodyScale(depth, fov, state.size.height))
    if (label.current) label.current.style.maxWidth = compact ? `${Math.max(80, state.size.width / 2 - 18)}px` : '190px'
    // A small route-directed heading keeps the face readable without a free-running
    // billboard wobble. This follows the same held route sample while paused.
    sampleAgentPresentation(route, poses, t + .5, scratch.home, index, scratch.previous)
    scratch.previous.sub(scratch.point).applyQuaternion(scratch.inverseCamera.copy(state.camera.quaternion).invert())
    scratch.heading.set(Math.atan2(-scratch.previous.y, 35) * .22, Math.atan2(scratch.previous.x, 35) * .3, 0)
    body.current.quaternion.copy(state.camera.quaternion)
    body.current.quaternion.multiply(scratch.inverseCamera.setFromEuler(scratch.heading))
    if (orbit.current) { orbit.current.rotation.y = t * .1; orbit.current.rotation.z = .28 + Math.sin(t * .13) * .025 }
    if (fins.current) fins.current.rotation.z = Math.sin(t * .35) * .025
    if (trail.current) {
      trail.current.count = visits > 0 && active ? TRAIL : 0
      for (let i = 0; i < trail.current.count; i++) {
        sampleAgentPresentation(route, poses, Math.max(0, t - (i + 1) * .26), scratch.home, index, scratch.previous)
        scratch.object.position.copy(scratch.previous).add(scratch.clearance)
        // The old sub-unit trail disappeared at overview distance. Keep this actual
        // sampled route leg readable as a tapered 1–3 px trail.
        scratch.object.scale.setScalar(unitsPerPixel * (.35 + (1 - i / TRAIL) * .65) / .3)
        scratch.object.updateMatrix()
        trail.current.setMatrixAt(i, scratch.object.matrix)
      }
      trail.current.instanceMatrix.needsUpdate = true
    }
  }, -.5 + index * .00001)

  return <group name={`world-agent-${agent?.record.id ?? GUIDE_ID}`}>
    <instancedMesh ref={trail} args={[undefined, undefined, TRAIL]} frustumCulled={false} raycast={() => {}}>
      <sphereGeometry args={[.3, 8, 6]} /><meshBasicMaterial color={tint} transparent opacity={.42} depthWrite={false} toneMapped={false} />
    </instancedMesh>
    <group ref={body} scale={1.45} onPointerDown={stopPointer} onPointerUp={stopPointer} onClick={(event) => { stopPointer(event); onOpen() }}>
      <mesh><sphereGeometry args={[2.4, 32, 24]} /><meshStandardMaterial color={active ? shell : '#697078'} metalness={.35} roughness={.32} emissive={active ? shell : '#697078'} emissiveIntensity={.32} /></mesh>
      <mesh rotation={[Math.PI / 2, .35, 0]}><torusGeometry args={[2.43, .035, 6, 64]} /><meshStandardMaterial color={tint} metalness={.8} roughness={.2} /></mesh>
      <mesh position={[0, 0, 2.08]} scale={[1, 1, .4]}><sphereGeometry args={[1.3, 28, 20]} /><meshStandardMaterial color="#030912" metalness={.08} roughness={.35} /></mesh>
      <mesh position={[0, 0, 2.53]}><torusGeometry args={[1.05, .085, 8, 48]} /><meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={active ? 1.2 : .15} /></mesh>
      <mesh position={[.18, .1, 2.7]}><sphereGeometry args={[.32, 16, 12]} /><meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={active ? 3 : .25} /></mesh>
      <group ref={fins}>
        {[-1, 1].map((side) => <group key={side}>
          <mesh position={[side * 2.9, -.25, -.3]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.075, .075, 1.3, 8]} /><meshStandardMaterial color={tint} metalness={.5} roughness={.3} /></mesh>
          <mesh position={[side * 3.7, -.3, -.3]} rotation={[0, 0, side * -.4]} scale={[1.1, .3, .75]}><sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial color={shell} metalness={.45} roughness={.3} emissive={shell} emissiveIntensity={.15} /></mesh>
        </group>)}
        <mesh position={[0, -2.2, -.5]} scale={[.9, .35, 1.4]}><sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial color={shell} metalness={.7} roughness={.3} /></mesh>
      </group>
      <group ref={orbit} rotation={[.4, 0, .35]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[3.8, .028, 5, 72]} /><meshBasicMaterial color={tint} transparent opacity={.65} toneMapped={false} /></mesh>
        {[0, Math.PI * .8, Math.PI * 1.45].map((angle, i) => <mesh key={i} position={[Math.cos(angle) * 3.8, 0, Math.sin(angle) * 3.8]}><sphereGeometry args={[i === 0 ? .38 : .22, 12, 8]} /><meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={active ? 1.7 : .2} /></mesh>)}
      </group>
      <Html position={[0, -7.5, 0]} center zIndexRange={[4, 0]}>
        <button ref={label} aria-label={title} className={`world-agent-label ${guide ? 'is-guide' : ''} ${active ? '' : 'is-idle'}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpen() }} title={guide ? 'Open your world guide and local query agents' : `${title} · ${active ? 'local query' : 'paused'}`}><i /><span>{guide ? 'Guide' : `${agent.record.title} agent`}</span></button>
      </Html>
    </group>
  </group>
}

/** Avatars are controls tied to saved queries; the guide is explicit UI, never a note. */
export function AgentLayer({ onOpen = openAgentsPanel }: { onOpen?: () => void }) {
  const nodes = useWorld((s) => s.nodes)
  const settings = useWorld((s) => s.settings)
  const historyStep = useApp((s) => s.clock.step)
  const screenPositions = useMemo<ScreenRegistry>(() => new Map(), [])
  const agents = useMemo(() => {
    // The pose table is mutable; the published history step invalidates born membership.
    void historyStep
    return settings ? queryAgents(nodes.values(), settings) : []
  }, [nodes, settings, historyStep])
  const home = useMemo(() => {
    const world = spatialWorldFor(nodes)
    return world.clusters[0]?.center ?? world.bounds.center
  }, [nodes])
  const guideRoute = useMemo(() => [...nodes.values()].filter((r) => r.archetype !== 'demon').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4).map((r) => r.id), [nodes])
  if (!settings?.firstRunComplete) return null
  return <group name="world-agents"><AgentAvatar guideRoute={guideRoute} guideHome={home} onOpen={onOpen} screenPositions={screenPositions} />{agents.map((agent, i) => <AgentAvatar key={agent.record.id} agent={agent} index={i + 1} onOpen={onOpen} screenPositions={screenPositions} />)}</group>
}
