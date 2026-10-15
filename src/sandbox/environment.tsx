import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { AgXToneMapping } from 'three'
import { useApp, useWorld } from '../app/store.ts'
import { MS_PER_YEAR, STEPS_PER_YEAR, Y_PER_YEAR } from '../domain/constants.ts'
import { placeAnchor, toPlacedAnchors } from '../domain/placement.ts'
import { yOf } from '../domain/time.ts'
import { SCHEMA_VERSION, type NodeRecord, type WorldSettings } from '../domain/types.ts'
import { EnvironmentScene } from '../world/environment/index.tsx'
import { enableMainCameraLayers } from '../world/layers.ts'
import { spurIntersectsCore } from '../world/paths.ts'
import { usePathGraph } from '../world/environment/usePathGraph.ts'

// #/sandbox/environment: the brutalist shell on a fake 30-year world with a dozen memories.
//   Buttons: toggle third person (mounts the reflector floor), cycle reflector quality,
//   toggle an empty world (Present plinth). window.__envSandbox exposes the renderer for QA.

const DAY = 86_400_000
const TAGS = ['childhood', 'music', 'physics', 'travel', 'loss', 'work', 'city', 'sea', 'friends', 'books', 'night', 'home']

function fakeWorld(): { settings: WorldSettings; records: NodeRecord[] } {
  const now = Math.floor(Date.now() / DAY) * DAY
  const T0 = now - 30 * MS_PER_YEAR
  const settings: WorldSettings = {
    T0,
    yPerYear: Y_PER_YEAR,
    stepsPerYear: STEPS_PER_YEAR,
    physicsSeed: 1,
    qualityTier: 'high',
    firstRunComplete: true,
    lastBackupAt: null,
    autoBackupEnabled: false,
    createdAt: now,
    schemaVersion: SCHEMA_VERSION,
  }
  const records: NodeRecord[] = []
  const years = [1.3, 3.9, 6.2, 8.8, 11.4, 13.1, 15.7, 18.2, 20.6, 23.3, 26.1, 28.4, 29.7, 31.5]
  years.forEach((yr, i) => {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
    const draft: NodeRecord = {
      id,
      slug: `memory-${i + 1}`,
      archetype: 'memory',
      title: `Memory ${i + 1}`,
      contentMd: '',
      tags: [TAGS[i % TAGS.length]],
      temporalOrigin: T0 + yr * MS_PER_YEAR,
      temporalPrecision: 'day',
      referenceDate: null,
      thermo: { mass: 1, temperature: 0.2 },
      anchorXZ: [0, 0],
      links: [],
      attachments: [],
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
    }
    draft.anchorXZ = placeAnchor(draft, toPlacedAnchors(records, { T0 }), { T0 })
    records.push(draft)
  })
  return { settings, records }
}

/** Cheap QA hook: renderer stats in the corner, refreshed twice a second. */
function Probe({ out }: { out: RefObject<HTMLDivElement | null> }) {
  const gl = useThree((s) => s.gl)
  const acc = useRef(0)
  useEffect(() => {
    ;(window as unknown as { __envSandbox?: unknown }).__envSandbox = { gl }
  }, [gl])
  useFrame((_, dt) => {
    acc.current += dt
    if (acc.current < 0.5 || !out.current) return
    acc.current = 0
    const r = gl.info.render
    out.current.textContent = `calls ${r.calls} · tris ${(r.triangles / 1000).toFixed(0)}k · ${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps`
  })
  return null
}

function GraphReport() {
  const g = usePathGraph()
  const bad = g.spurs.filter((s) => spurIntersectsCore(s)).length
  return (
    <div className="hud-label">
      {g.landings.length} landings · {g.spurs.length} spurs · max |stairDY| {Math.max(0, ...g.spurs.map((s) => Math.abs(s.stairDY))).toFixed(2)} · core hits {bad} · present y{' '}
      {g.present.y.toFixed(1)}
    </div>
  )
}

export default function EnvironmentSandbox() {
  const world = useMemo(fakeWorld, [])
  const [empty, setEmpty] = useState(false)
  const mode = useApp((s) => s.mode)
  const reflector = useApp((s) => s.quality.reflector)
  const stats = useRef<HTMLDivElement>(null)

  useEffect(() => {
    useWorld.getState().hydrate(world.settings, empty ? [] : world.records)
  }, [world, empty])

  const yNow = yOf(Date.now(), world.settings.T0)

  return (
    <div className="relative h-full w-full bg-void" style={{ height: '100vh' }}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        camera={{ position: [150, yNow + 70, 190], fov: 45, near: 0.5, far: 6000 }}
        onCreated={({ gl, camera }) => {
          gl.toneMapping = AgXToneMapping
          enableMainCameraLayers(camera)
        }}
      >
        <EnvironmentScene />
        <OrbitControls target={[0, yNow * 0.55, 0]} maxDistance={1400} enableDamping />
        <Probe out={stats} />
      </Canvas>
      <div className="hud-panel absolute left-4 top-4 flex flex-col gap-2 p-3">
        <div className="hud-label">ENVIRONMENT SANDBOX · T0 = now − 30 y</div>
        <GraphReport />
        <div ref={stats} className="hud-label" />
        <div className="flex gap-2">
          <button
            className="hud-btn"
            onClick={() => useApp.getState().setMode(mode === 'third_person' ? 'orbit' : 'third_person')}
          >
            {mode === 'third_person' ? 'THIRD PERSON (REFLECTOR)' : 'ORBIT (PLAIN FLOOR)'}
          </button>
          <button
            className="hud-btn"
            onClick={() =>
              useApp.getState().setQuality({ reflector: reflector === 'full' ? '512' : reflector === '512' ? 'off' : 'full' })
            }
          >
            REFLECTOR {reflector.toUpperCase()}
          </button>
          <button className="hud-btn" onClick={() => setEmpty((e) => !e)}>
            {empty ? 'EMPTY WORLD' : '14 MEMORIES'}
          </button>
        </div>
      </div>
    </div>
  )
}
