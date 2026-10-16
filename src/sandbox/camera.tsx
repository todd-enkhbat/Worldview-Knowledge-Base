import { useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { Color, Matrix4, Object3D, Vector3, type InstancedMesh } from 'three'
import { useApp } from '../app/store.ts'
import { CORE_RADIUS, HELIX, SPUR_HALF_WIDTH } from '../domain/placement.ts'
import { setPoseTable } from '../world/poses.ts'
import { CameraRig, flyTo, useProximity } from '../world/camera/index.tsx'
import { HELIX_ARC_PER_Y, helixPoint, helixTangent, prepareWalkGraph, stubWalkGraph, type WalkGraph } from '../world/camera/walkGraph.ts'

// #/sandbox/camera: exercises the camera rig on a stand-in world.
//   orbit (default) · T third person · F first person · O orbit · Esc (escape precedence)
//   third person: W/S ↑/↓ walk the helix, A/D step onto/off a spur, Shift runs, drag orbits.
// The catwalk is the placement-contract stub (stubWalkGraph); swap in buildPathGraph() once
// world/paths.ts lands.

const YEARS = 10
const Y_MAX = YEARS * HELIX.pitch
const MEMORY_COUNT = 14

interface FakeNode {
  id: string
  anchorXZ: [number, number]
  y: number
}

function makeNodes(): FakeNode[] {
  // Deterministic scatter: golden-angle sectors, radii 22–40 u, one memory every ~8.5 u up.
  const out: FakeNode[] = []
  for (let i = 0; i < MEMORY_COUNT; i++) {
    const a = i * 2.39996 + 0.4
    const r = 22 + ((i * 7919) % 19)
    out.push({ id: `mem-${String(i + 1).padStart(3, '0')}`, anchorXZ: [Math.cos(a) * r, Math.sin(a) * r], y: 4 + i * ((Y_MAX - 8) / (MEMORY_COUNT - 1)) })
  }
  return out
}

const CONCRETE = '#8d8a84'
const CONCRETE_DARK = '#4a4844'
const EMBER_HDR = new Color('#e8b04a').multiplyScalar(5)

export default function CameraSandbox() {
  const nodes = useMemo(makeNodes, [])
  const source = useMemo(() => stubWalkGraph(nodes, 0, Y_MAX), [nodes])
  const graph = useMemo(() => prepareWalkGraph(source), [source])

  // Publish the fake nodes as the live pose table (all born) so proximity has something to find.
  useLayoutEffect(() => {
    const index = new Map<string, number>()
    const pos = new Float32Array(nodes.length * 3)
    nodes.forEach((n, i) => {
      index.set(n.id, i)
      pos.set([n.anchorXZ[0], n.y, n.anchorXZ[1]], i * 3)
    })
    setPoseTable({ index, pos, born: new Uint8Array(nodes.length).fill(1) })
  }, [nodes])

  return (
    <div className="relative h-full w-full bg-void">
      <Canvas camera={{ position: [70, 70, 70], fov: 50, near: 0.1, far: 4000 }} dpr={[1, 1.5]}>
        <color attach="background" args={['#050506']} />
        <Environment frames={1} resolution={128}>
          <Lightformer form="rect" intensity={3} color="#f2e6d2" position={[0, 20, -30]} scale={[40, 10, 1]} />
          <Lightformer form="rect" intensity={1.5} color="#e8b04a" position={[30, 4, 20]} scale={[20, 4, 1]} />
          <Lightformer form="ring" intensity={0.6} color="#ff4a1c" position={[-25, 10, 10]} scale={6} />
        </Environment>
        <ambientLight intensity={0.15} />
        <directionalLight position={[40, 120, 30]} intensity={1.6} color="#f1e8dc" />
        <CameraRig paths={source} />
        <World graph={graph} nodes={nodes} />
      </Canvas>
      <Hud nodes={nodes} />
    </div>
  )
}

// ─── stand-in world ───────────────────────────────────────────────────────────────────

const tmpObj = new Object3D()
const tmpP = new Vector3()
const tmpT = new Vector3()
const tmpM = new Matrix4()
const X_AXIS = new Vector3(1, 0, 0)

function World({ graph, nodes }: { graph: WalkGraph; nodes: FakeNode[] }) {
  const deck = useRef<InstancedMesh>(null)
  const spurs = useRef<InstancedMesh>(null)
  const cubes = useRef<InstancedMesh>(null)
  const select = useApp((s) => s.select)

  // Helix deck: one slab per ~0.9 u of arc, long axis along the tangent.
  const slabStep = 0.9
  const slabCount = Math.ceil(((graph.yMax - graph.yMin) * HELIX_ARC_PER_Y) / slabStep)
  const segCount = graph.spurs.reduce((n, s) => n + s.cum.length - 1, 0)

  useLayoutEffect(() => {
    const d = deck.current
    if (d) {
      for (let i = 0; i < slabCount; i++) {
        const y = graph.yMin + (i + 0.5) * (slabStep / HELIX_ARC_PER_Y)
        helixPoint(y, tmpP)
        helixTangent(y, tmpT)
        tmpObj.position.set(tmpP.x, tmpP.y - 0.15, tmpP.z)
        tmpObj.quaternion.setFromUnitVectors(X_AXIS, tmpT)
        tmpObj.scale.set(slabStep * 1.02, 0.3, SPUR_HALF_WIDTH * 2.2)
        tmpObj.updateMatrix()
        d.setMatrixAt(i, tmpObj.matrix)
      }
      d.instanceMatrix.needsUpdate = true
      d.computeBoundingSphere()
    }
    const s = spurs.current
    if (s) {
      let k = 0
      for (const sp of graph.spurs) {
        for (let j = 0; j + 1 < sp.cum.length; j++) {
          const o = j * 3
          tmpP.set(sp.pts[o], sp.pts[o + 1], sp.pts[o + 2])
          tmpT.set(sp.pts[o + 3], sp.pts[o + 4], sp.pts[o + 5]).sub(tmpP)
          const len = tmpT.length()
          const vertical = Math.abs(tmpT.y) > len * 0.9
          tmpObj.position.copy(tmpP).addScaledVector(tmpT, 0.5)
          tmpObj.position.y -= 0.15
          tmpObj.quaternion.setFromUnitVectors(X_AXIS, tmpT.normalize())
          // Pier stairs read as a narrow shaft; deck runs as a slab.
          tmpObj.scale.set(len + (vertical ? 0.3 : 0), vertical ? 0.8 : 0.3, vertical ? 0.8 : SPUR_HALF_WIDTH * 2)
          tmpObj.updateMatrix()
          s.setMatrixAt(k++, tmpObj.matrix)
        }
      }
      s.instanceMatrix.needsUpdate = true
      s.computeBoundingSphere()
    }
    const c = cubes.current
    if (c) {
      nodes.forEach((n, i) => {
        tmpM.makeTranslation(n.anchorXZ[0], n.y, n.anchorXZ[1])
        c.setMatrixAt(i, tmpM)
      })
      c.instanceMatrix.needsUpdate = true
      c.computeBoundingSphere()
    }
  }, [graph, nodes, slabCount])

  // Ignore the click that ends an orbit drag.
  const onPick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta <= 4 && e.instanceId !== undefined) select(nodes[e.instanceId].id)
  }

  return (
    <group>
      {/* reflector-floor stand-in */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} onClick={(e) => e.delta <= 4 && select(null)}>
        <planeGeometry args={[600, 600]} />
        <meshStandardMaterial color="#141414" roughness={0.6} metalness={0.2} />
      </mesh>
      {/* the core */}
      <mesh position={[0, (Y_MAX + 24) / 2, 0]}>
        <cylinderGeometry args={[CORE_RADIUS, CORE_RADIUS, Y_MAX + 24, 48, 1]} />
        <meshStandardMaterial color={CONCRETE_DARK} roughness={0.95} />
      </mesh>
      <instancedMesh key={`deck-${slabCount}`} ref={deck} args={[undefined, undefined, slabCount]}>
        <boxGeometry />
        <meshStandardMaterial color={CONCRETE} roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`spur-${segCount}`} ref={spurs} args={[undefined, undefined, Math.max(1, segCount)]}>
        <boxGeometry />
        <meshStandardMaterial color={CONCRETE} roughness={0.85} />
      </instancedMesh>
      <instancedMesh key={`cube-${nodes.length}`} ref={cubes} args={[undefined, undefined, nodes.length]} onClick={onPick}>
        <boxGeometry args={[2.4, 2.4, 2.4]} />
        <meshStandardMaterial color="#cfd2d4" metalness={1} roughness={0.18} />
      </instancedMesh>
      <NearestMarker nodes={nodes} />
    </group>
  )
}

/** Ember cage around the proximity winner; re-renders only when the nearest node changes. */
function NearestMarker({ nodes }: { nodes: FakeNode[] }) {
  const nearestId = useProximity((s) => s.nearestId)
  const n = nearestId ? nodes.find((x) => x.id === nearestId) : undefined
  if (!n) return null
  return (
    <mesh position={[n.anchorXZ[0], n.y, n.anchorXZ[1]]}>
      <boxGeometry args={[3.2, 3.2, 3.2]} />
      <meshBasicMaterial color={EMBER_HDR} wireframe toneMapped={false} />
    </mesh>
  )
}

// ─── HUD ──────────────────────────────────────────────────────────────────────────────

function Hud({ nodes }: { nodes: FakeNode[] }) {
  const mode = useApp((s) => s.mode)
  const selectedId = useApp((s) => s.selectedId)
  const paletteOpen = useApp((s) => s.panels.palette)
  const togglePanel = useApp((s) => s.togglePanel)
  const nearestId = useProximity((s) => s.nearestId)
  const distance = useProximity((s) => s.distance)

  return (
    <div className="pointer-events-none absolute inset-0 p-4 font-mono text-[11px] text-bone">
      <div className="hud-panel pointer-events-auto inline-block max-w-[360px] p-3">
        <div className="hud-label mb-2">camera rig · sandbox</div>
        <Row k="mode" v={mode} />
        <Row k="nearest" v={nearestId ? `${nearestId} · ${distance.toFixed(1)} u` : '—'} />
        <Row k="selected" v={selectedId ?? '—'} />
        <Row k="palette" v={paletteOpen ? 'open' : 'closed'} />
        <div className="mt-2 leading-5 text-concrete">
          T third person · F first person · O orbit · Esc escape
          <br />
          3rd: W/S ↑/↓ helix · A/D spur · Shift run · drag look
          <br />
          1st: WASD · Q/E down/up · drag look · Shift ×5
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="hud-btn" onClick={() => flyTo(nodes[Math.floor(Math.random() * nodes.length)].id)}>
            fly to random
          </button>
          <button className="hud-btn" onClick={() => flyTo([0, Y_MAX / 2, 0], { distance: 140 })}>
            frame column
          </button>
          <button className="hud-btn" onClick={() => togglePanel('palette', true)}>
            open palette
          </button>
        </div>
        <input className="hud-panel mt-3 w-full p-1" placeholder="typing here ignores camera keys" />
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-16 text-concrete">{k}</span>
      <span>{v}</span>
    </div>
  )
}
