import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { OrbitControls } from '@react-three/drei'
import { BackSide, Color, Object3D, type InstancedMesh } from 'three'
import { useApp, type CameraMode } from '../app/store.ts'
import { HyperspaceCanvas } from '../world/HyperspaceCanvas.tsx'
import { LAYER, RENDER_ORDER } from '../world/layers.ts'
import type { PostChain } from '../world/post/chain.ts'
import { PostStack } from '../world/post/PostStack.tsx'
import { postModeFlags, setPostFocus } from '../world/post/postMode.ts'
import { useRenderStats } from '../world/renderStats.ts'

// #/sandbox/post: the canvas + post stack in isolation. Concrete monoliths on a plane
// receding into the exp² fog, a tower climbing out of the height fog, HDR emissive bars
// that should bloom (and nothing else should), and a glass cube whose depth-only back-face
// proxy lets fog and DOF see it. Orbit with the mouse; the panel flips camera modes and
// DOF focus to exercise the mode-dependent post.

const CONCRETE = '#8d8a84'
const EMBER = new Color('#e8b04a').multiplyScalar(7)
const SIGNAL = new Color('#ff4a1c').multiplyScalar(9)
const BRASS = '#c9973f'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Block {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
}

function buildBlocks(): Block[] {
  const rnd = mulberry32(7)
  const blocks: Block[] = []
  // Two rows of monoliths marching away down −z, out to ~1.5 km.
  for (let i = 0; i < 60; i++) {
    const z = -12 - i * 24 - rnd() * 8
    for (const side of [-1, 1]) {
      const sy = 6 + rnd() * 26
      const sx = 3 + rnd() * 5
      blocks.push({ x: side * (16 + rnd() * 14), y: sy / 2, z, sx, sy, sz: 3 + rnd() * 6 })
    }
  }
  // Scattered plinths near the camera.
  for (let i = 0; i < 24; i++) {
    const sy = 0.6 + rnd() * 2.5
    blocks.push({ x: (rnd() - 0.5) * 60, y: sy / 2, z: (rnd() - 0.5) * 50, sx: 2 + rnd() * 4, sy, sz: 2 + rnd() * 4 })
  }
  // A stacked tower rising 600 u out of the dense low fog into the thin upper air.
  for (let i = 0; i < 50; i++) {
    const y = i * 12 + 3
    const r = i % 2 === 0 ? 7 : 5
    blocks.push({ x: -70, y, z: -160, sx: r * 2, sy: 4, sz: r * 2 })
  }
  return blocks
}

function Monoliths() {
  const blocks = useMemo(buildBlocks, [])
  const ref = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const o = new Object3D()
    blocks.forEach((b, i) => {
      o.position.set(b.x, b.y, b.z)
      o.scale.set(b.sx, b.sy, b.sz)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [blocks])
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, blocks.length]} layers={LAYER.SOLID}>
      <boxGeometry />
      <meshStandardMaterial color={CONCRETE} roughness={0.92} metalness={0} />
    </instancedMesh>
  )
}

const BARS: { p: [number, number, number]; s: [number, number, number]; c: Color }[] = [
  { p: [-6, 3, -4], s: [0.25, 6, 0.25], c: EMBER },
  { p: [6, 3, -4], s: [0.25, 6, 0.25], c: EMBER },
  { p: [0, 6.2, -4], s: [12.25, 0.25, 0.25], c: SIGNAL },
  { p: [-18, 1.2, -60], s: [8, 0.2, 0.2], c: EMBER },
  { p: [20, 9, -180], s: [0.4, 18, 0.4], c: SIGNAL },
  { p: [-24, 14, -420], s: [0.6, 28, 0.6], c: EMBER },
]

function EmissiveBars() {
  return (
    <group>
      {BARS.map((b, i) => (
        <mesh key={i} position={b.p} scale={b.s} layers={LAYER.SOLID}>
          <boxGeometry />
          <meshBasicMaterial color={b.c} toneMapped={false} />
        </mesh>
      ))}
    </group>
  )
}

/** Dark-glass cube with a depth-only back-face proxy, as the dioramas use. */
function GlassCube() {
  return (
    <group position={[12, 4, 8]}>
      <mesh layers={LAYER.GLASS} renderOrder={RENDER_ORDER.FRONT_SHELL}>
        <boxGeometry args={[8, 8, 8]} />
        <meshStandardMaterial color="#0d1418" transparent opacity={0.35} roughness={0.08} metalness={0.6} depthWrite={false} />
      </mesh>
      <mesh layers={LAYER.GLASS} renderOrder={RENDER_ORDER.DEPTH_PROXY}>
        <boxGeometry args={[8, 8, 8]} />
        <meshBasicMaterial side={BackSide} colorWrite={false} depthWrite />
      </mesh>
      <mesh position={[0, 0, 0]} layers={LAYER.SOLID}>
        <octahedronGeometry args={[1.6, 0]} />
        <meshStandardMaterial color={BRASS} roughness={0.25} metalness={1} />
      </mesh>
    </group>
  )
}

function Scene() {
  return (
    <>
      <hemisphereLight args={['#4a4740', '#050505', 0.6]} />
      <directionalLight position={[-60, 80, 40]} intensity={4} color="#f1e3c8" />
      <mesh rotation-x={-Math.PI / 2} layers={LAYER.SOLID}>
        <planeGeometry args={[6000, 6000]} />
        <meshStandardMaterial color="#5f5c57" roughness={0.96} />
      </mesh>
      <Monoliths />
      <EmissiveBars />
      <GlassCube />
    </>
  )
}

const MODES: CameraMode[] = ['orbit', 'third_person', 'autonav', 'entering', 'interior', 'first_person']
const FOCI: { label: string; p: [number, number, number] | null }[] = [
  { label: 'auto', p: null },
  { label: 'near', p: [0, 3, -4] },
  { label: 'glass', p: [12, 4, 8] },
  { label: 'far', p: [20, 9, -180] },
]

function Panel({ post }: { post: RefObject<PostChain | null> }) {
  const mode = useApp((s) => s.mode)
  const dofOnlyFlyIn = useApp((s) => s.quality.dofOnlyFlyIn)
  const dpr = useApp((s) => s.quality.dpr)
  const tier = useApp((s) => s.quality.tier)
  const calls = useRenderStats((s) => s.calls)
  const tris = useRenderStats((s) => s.triangles)
  const programs = useRenderStats((s) => s.programs)
  const p95 = useRenderStats((s) => s.frameMs.p95)
  const fps = useRenderStats((s) => s.fps)
  const [focus, setFocus] = useState('auto')
  const [density, setDensity] = useState(1.6)
  const [height, setHeight] = useState(1.6)
  const flags = postModeFlags(mode, dofOnlyFlyIn)

  return (
    <div className="hud-panel absolute left-4 top-4 w-72 space-y-3 p-3 font-mono text-[11px] uppercase">
      <div className="hud-label">post sandbox</div>
      <div className="flex flex-wrap gap-1">
        {MODES.map((m) => (
          // Sandbox only: bypass the transition table to jump straight to any mode.
          <button key={m} className="hud-btn" aria-pressed={m === mode} onClick={() => useApp.setState({ mode: m })}>
            {m}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <span className="hud-label">focus</span>
        {FOCI.map((f) => (
          <button
            key={f.label}
            className="hud-btn"
            aria-pressed={f.label === focus}
            onClick={() => {
              setFocus(f.label)
              setPostFocus(f.p ? { x: f.p[0], y: f.p[1], z: f.p[2] } : null)
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={dofOnlyFlyIn}
          onChange={(e) => useApp.getState().setQuality({ dofOnlyFlyIn: e.target.checked })}
        />
        dof only fly-in
      </label>
      <label className="block">
        fog exp² ×1e-3 {density.toFixed(1)}
        <input
          className="w-full"
          type="range"
          min={0}
          max={8}
          step={0.1}
          value={density}
          onChange={(e) => {
            const v = Number(e.target.value)
            setDensity(v)
            if (post.current?.fog) post.current.fog.density = v / 1000
          }}
        />
      </label>
      <label className="block">
        height fog ×1e-3 {height.toFixed(1)}
        <input
          className="w-full"
          type="range"
          min={0}
          max={10}
          step={0.1}
          value={height}
          onChange={(e) => {
            const v = Number(e.target.value)
            setHeight(v)
            if (post.current?.fog) post.current.fog.heightDensity = v / 1000
          }}
        />
      </label>
      <div className="grid grid-cols-2 gap-x-2 text-concrete">
        <span>dof</span>
        <span>{flags.dof ? 'on' : 'off'}</span>
        <span>height fog</span>
        <span>{flags.heightFog ? 'on' : 'off'}</span>
        <span>tier · dpr</span>
        <span>
          {tier} · {dpr}
        </span>
        <span>calls · tris</span>
        <span>
          {calls} · {tris}
        </span>
        <span>programs</span>
        <span>{programs}</span>
        <span>fps · p95</span>
        <span>
          {fps.toFixed(0)} · {p95.toFixed(1)} ms
        </span>
      </div>
    </div>
  )
}

export default function PostSandbox() {
  const post = useRef<PostChain | null>(null)
  return (
    <div className="relative h-full w-full">
      <HyperspaceCanvas camera={{ position: [34, 12, 42] }}>
        <Scene />
        <OrbitControls makeDefault target={[0, 5, -20]} enableDamping maxDistance={2500} />
        <PostStack ref={post} />
      </HyperspaceCanvas>
      <Panel post={post} />
    </div>
  )
}
