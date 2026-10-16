import { useEffect, useLayoutEffect, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Environment, Lightformer, OrbitControls, Stars } from '@react-three/drei'
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { HalfFloatType } from 'three'
import { useApp, useWorld } from '../app/store.ts'
import { STEPS_PER_YEAR, Y_PER_YEAR } from '../domain/constants.ts'
import type { Archetype, LinkKind, NodeRecord, WorldSettings } from '../domain/types.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import { makeNodeDraft } from '../domain/validate.ts'
import { enableMainCameraLayers } from '../world/layers.ts'
import { LinkLayer } from '../world/links/index.tsx'
import { NodeLayer, usePoseWriterStatic } from '../world/nodes/index.tsx'
import { getPoseTable, touchPoseTable } from '../world/poses.ts'

// Sandbox for the node archetypes, links and the static pose writer: three records of each
// archetype on radial rows facing the camera (nodes face the world axis), the outermost of
// each row optionally an unborn ghost. Hover, click, double-click a memory's glass.

const T0 = Date.UTC(1994, 0, 1)
const DAY = 86_400_000
const ORIGIN = Date.UTC(1994, 2, 1)

const TITLES: Record<Archetype, [string, string, string]> = {
  idea: ['Second law of thermodynamics', 'Entropy as missing information', 'Free energy principle'],
  entity: ['Ludwig Boltzmann', 'Tadao Ando', 'Lebbeus Woods'],
  lens: ['Systems thinking', 'Bayesian reasoning', 'Stoicism'],
  document: ['On the Electrodynamics of Moving Bodies', 'Notes on brutalism', 'Reading log, winter'],
  memory: ['First night at the observatory', 'Rain on the concrete church', 'Leaving Ulaanbaatar'],
  demon: ['entropy watcher', 'architecture sorter', 'dormant demon'],
}
const ORDER: Archetype[] = ['idea', 'entity', 'lens', 'document', 'memory', 'demon']
const RADII = [16, 23, 30]

function buildFixture(): { settings: WorldSettings; records: NodeRecord[]; ghostIds: string[] } {
  const now = Date.now()
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
  const at: Record<string, NodeRecord> = {}
  ORDER.forEach((arch, col) => {
    // Columns fan from 40° to 140° in front of the camera; rows step outward.
    const theta = ((40 + (col * 100) / (ORDER.length - 1)) * Math.PI) / 180
    RADII.forEach((r, row) => {
      const rec = makeNodeDraft(
        arch,
        {
          title: TITLES[arch][row],
          tags: [arch, 'sandbox'],
          temporalOrigin: ORIGIN + (col * 3 + row) * 9 * DAY,
          anchorXZ: [Math.cos(theta) * r, Math.sin(theta) * r],
          thermo: { mass: [0.6, 1.5, 3.5][row], temperature: 0.3 },
        },
        { now },
      )
      if (arch === 'demon') rec.demon = { query: TITLES.demon[row], radius: 3 + row, active: row !== 2 }
      if (arch === 'entity') rec.entity = { kind: row === 0 ? 'person' : 'other' }
      records.push(rec)
      at[`${arch}${row}`] = rec
    })
  })
  const link = (a: string, b: string, kind: LinkKind = 'relates') =>
    at[a].links.push({ targetId: at[b].id, kind, createdAt: now })
  link('entity0', 'idea0', 'influenced-by')
  link('entity0', 'idea1')
  link('entity0', 'document0')
  link('memory0', 'entity0')
  link('lens0', 'idea1', 'supports')
  link('document1', 'memory1', 'contradicts')
  link('idea2', 'idea0', 'derives')
  link('demon0', 'lens0')
  link('entity1', 'memory1')
  const ghostIds = ORDER.map((a) => at[`${a}2`].id)
  return { settings, records, ghostIds }
}

const FIXTURE = buildFixture()
const TARGET: [number, number, number] = [0, 2.5, 19]

function Scene({ ghosts }: { ghosts: boolean }) {
  usePoseWriterStatic()
  const revision = useWorld((s) => s.revision)
  const camera = useThree((s) => s.camera)

  useEffect(() => enableMainCameraLayers(camera), [camera])

  // Runs after the writer's layout effect in the same commit, so the override sticks.
  useLayoutEffect(() => {
    const table = getPoseTable()
    for (const id of FIXTURE.ghostIds) {
      const row = table.index.get(id)
      if (row !== undefined) table.born[row] = ghosts ? 0 : 1
    }
    touchPoseTable()
  }, [ghosts, revision])

  return (
    <>
      <color attach="background" args={['#050506']} />
      <Stars radius={260} depth={80} count={5000} factor={5} saturation={0} fade speed={0.25} />
      <ambientLight intensity={0.12} />
      <directionalLight position={[-12, 18, 4]} intensity={1.4} color="#ffe6c4" />
      <directionalLight position={[10, 6, 40]} intensity={0.5} color="#9fd3e6" />
      <Environment frames={1} resolution={256}>
        <color attach="background" args={['#030304']} />
        <Lightformer form="rect" intensity={3} color="#f2e6d0" position={[0, 7, -10]} scale={[16, 1.2, 1]} />
        <Lightformer form="rect" intensity={1.4} color="#9fd3e6" position={[-12, 2, 6]} rotation-y={Math.PI / 2} scale={[12, 0.5, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#e8b04a" position={[12, 1, 10]} rotation-y={-Math.PI / 2} scale={[8, 0.35, 1]} />
        <Lightformer form="ring" intensity={1.6} color="#ffffff" position={[0, 12, 18]} rotation-x={Math.PI / 2} scale={8} />
      </Environment>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.6, 18]}>
        <circleGeometry args={[40, 96]} />
        <meshStandardMaterial color="#2b2a27" roughness={0.88} metalness={0} />
      </mesh>
      <NodeLayer />
      <LinkLayer />
      <OrbitControls makeDefault target={TARGET} enableDamping />
      <EffectComposer multisampling={0} frameBufferType={HalfFloatType}>
        <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.25} intensity={0.85} />
        <ToneMapping mode={ToneMappingMode.AGX} />
        <Noise opacity={0.035} />
        <Vignette offset={0.3} darkness={0.7} />
      </EffectComposer>
    </>
  )
}

function Readout() {
  const selectedId = useApp((s) => s.selectedId)
  const hoveredId = useApp((s) => s.hoveredId)
  const focusedId = useApp((s) => s.focusedId)
  const nodes = useWorld((s) => s.nodes)
  const name = (id: string | null) => (id ? (nodes.get(id)?.title ?? id) : '—')
  return (
    <div className="font-mono text-[11px] leading-5">
      <div>hover · {name(hoveredId)}</div>
      <div>select · {name(selectedId)}</div>
      <div>focus · {name(focusedId)}</div>
    </div>
  )
}

export default function NodesSandbox() {
  const [ghosts, setGhosts] = useState(true)
  const loaded = useWorld((s) => s.loaded)

  useEffect(() => {
    useWorld.getState().hydrate(FIXTURE.settings, FIXTURE.records)
  }, [])

  return (
    <div className="relative h-full w-full bg-void">
      {loaded && (
        <Canvas
          gl={{ antialias: false }}
          dpr={[1, 1.5]}
          camera={{ position: [0, 7, -6], fov: 45, near: 0.1, far: 2000 }}
          onPointerMissed={() => useApp.getState().select(null)}
        >
          <Scene ghosts={ghosts} />
        </Canvas>
      )}
      <div className="hud-panel absolute left-4 top-4 w-72 p-3">
        <div className="hud-label mb-2">sandbox · nodes</div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-concrete">
          idea · entity · lens · document · memory · demon
        </div>
        <Readout />
        <button className="hud-btn mt-3" onClick={() => setGhosts((g) => !g)}>
          {ghosts ? 'outer row: ghosts' : 'outer row: born'}
        </button>
      </div>
    </div>
  )
}
