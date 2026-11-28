import { useCallback, useEffect, useRef, useState } from 'react'
import { Color } from 'three'
import { markOnce } from '../app/timings.ts'
import { Hud } from '../hud/Hud.tsx'
import { CameraRig } from './camera/index.tsx'
import { DustLayer } from './dust/DustLayer.tsx'
import { EnvironmentScene } from './environment/index.tsx'
import { HyperspaceCanvas } from './HyperspaceCanvas.tsx'
import { LinkHover, LinkLayer } from './links/index.tsx'
import { NodeLayer } from './nodes/index.tsx'
import { Overlays } from './overlays/index.tsx'
import { PostStack } from './post/PostStack.tsx'
import { SplatLayer } from './splats/index.tsx'
import { usePlayheadClock } from './time/usePlayheadClock.ts'
import { usePhysicsPoses } from './time/usePhysicsPoses.ts'
import { AgentLayer } from './agents/AgentLayer.tsx'
import { FieldLayer } from './field/FieldLayer.tsx'
import { FieldPicker } from './field/FieldPicker.tsx'
import { useApp, useWorld } from '../app/store.ts'
import { Worldline } from './worldline/index.ts'
import ExploreBridge from '../workspace/ExploreBridge.tsx'
import { ExploreRecordLayer, exploreRecordPosition } from './ExploreRecordLayer.tsx'
import { ExploreRecordsPanel } from './ExploreRecordsPanel.tsx'
import type { ExploreRecord } from './exploreRecords.ts'
import { useExploreRecords } from './useExploreRecords.ts'
import { flyTo, getOrbitControls } from './camera/flyTo.ts'
import { prefersStillCamera } from './camera/cameraFlight.ts'
import { recenterWorld } from './camera/OrbitRig.tsx'
import { ensurePlayhead, seekPlayhead } from './time/clock.ts'
import { historyStepForRecord } from '../workspace/history.ts'
import './explore.css'

// #/ — the world. The data layer boots outside React (app/boot.ts); until first run completes
// the scene renders with a provisional T0 and the HUD shows FirstRun on top.

function Scene({ records, selected, onSelect }: { records: readonly ExploreRecord[]; selected?: ExploreRecord; onSelect: (record: ExploreRecord) => void }) {
  useEffect(() => markOnce('scene-mounted'), [])
  // The playhead clock (frame priority −3), then the pose writer (−2): physics worker
  // frames, or the static anchors when workers are unavailable.
  usePlayheadClock()
  usePhysicsPoses()
  // XYZ is semantic space. History controls births and evolution independently of height.
  // The World/Structure choice only changes the bounded molecular presentation around it.
  const field = useApp((s) => s.view.world === 'field')
  return (
    <>
      <EnvironmentScene />
      <NodeLayer />
      <ExploreRecordLayer records={records} selected={selected} onSelect={onSelect} />
      <LinkLayer />
      {field && <><FieldLayer /><FieldPicker /></>}
      <AgentLayer />
      <LinkHover />
      {/* The dissipative O layer (citadels, mist, synapses, demon lattice, satellites) plus
          dwell logging. A top-level 'overlays' group so the interior's world-hide covers it. */}
      <group name="overlays">
        <Overlays />
      </group>
      {/* The ember worldline through the memories in date order; autonav rides it. It hides
          itself in the interior. */}
      <Worldline />
      {/* GPU dust, stepped to the same playhead step as the node worker (frame −2). */}
      <DustLayer />
      {/* The world's one SparkRenderer + diorama tiers; outside the world groups so it
          survives the interior's world-hide. */}
      <SplatLayer />
      <CameraRig />
      <PostStack bokehScale={0} grain={0.006} bloomIntensity={0.4} fog={{ color: new Color('#07101d'), density: 0.00012, heightDensity: 0, heightFalloff: 1 / 45 }} />
    </>
  )
}

export default function WorldPage({ hash = '' }: { hash?: string }) {
  const ready = useWorld(state => state.settings?.firstRunComplete === true)
  const noNodes = useWorld(state => state.nodes.size === 0)
  const chat = useApp(state => state.panels.chat)
  const view = useApp(state => state.view.world)
  const flow = useApp(state => state.view.flow)
  const { records, load, retry } = useExploreRecords()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState(false)
  const [recordKey, setRecordKey] = useState<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const framedRecords = useRef(false)
  const selection = records.find(record => record.key === recordKey)

  const closeRecords = useCallback(() => {
    setOpen(false)
    setFocus(false)
    if (trigger.current?.isConnected) trigger.current.focus()
  }, [])
  const openRecords = useCallback((search = false) => {
    if (document.activeElement instanceof HTMLElement) trigger.current = document.activeElement
    useApp.getState().togglePanel('library', false)
    useApp.getState().togglePanel('demons', false)
    setFocus(search)
    setOpen(true)
  }, [])
  const clearRecord = useCallback(() => { setRecordKey(null) }, [])
  useEffect(() => {
    if (!ready || !noNodes || !records.length || framedRecords.current) return
    let frame = 0
    let attempts = 0
    const tryFrame = () => {
      if (getOrbitControls()) {
        framedRecords.current = recenterWorld()
      } else if (++attempts < 90) frame = requestAnimationFrame(tryFrame)
    }
    if (!recordKey) frame = requestAnimationFrame(tryFrame)
    return () => cancelAnimationFrame(frame)
  }, [ready, noNodes, records.length, recordKey])
  useEffect(() => useApp.subscribe((state, previous) => {
    if (state.selectedId && state.selectedId !== previous.selectedId) { setRecordKey(null); setOpen(false); setFocus(false) }
  }), [])
  const selectRecord = useCallback((record: ExploreRecord) => {
    const world = useWorld.getState()
    if (!world.settings) return
    const app = useApp.getState()
    app.select(null)
    app.focus(null)
    app.setClock({ playing: false })
    const now = Date.now()
    const current = ensurePlayhead(world.settings, now)
    const date = record.nodeId ? Math.max(record.date, world.nodes.get(record.nodeId)?.temporalOrigin ?? record.date) : record.date
    const target = historyStepForRecord(current, date, world.settings, now)
    if (target !== current) seekPlayhead(target)
    const distance = record.nodeId ? 34 : 39
    const opts = { distance, transition: !prefersStillCamera() }
    const node = record.nodeId ? world.nodes.get(record.nodeId) : undefined
    if (!node || !flyTo(node.id, opts)) flyTo(exploreRecordPosition(record), opts)
    framedRecords.current = true
    setRecordKey(record.key)
    setOpen(true)
  }, [])

  return (
    <div className={`world-workspace relative h-full w-full ${ready ? 'is-ready' : ''} ${chat ? 'has-chat' : ''}`} data-world-motion={flow ? 'on' : 'off'}>
      <div className="world-viewport">
        <HyperspaceCanvas>
          <Scene records={records} selected={selection} onSelect={selectRecord} />
        </HyperspaceCanvas>
        {flow && <div key={view} className="world-scene-transition" aria-hidden="true" />}
      </div>
      <div id="hud-root" className="pointer-events-none absolute inset-0">
        <Hud records={records} recordsOpen={open} onOpenRecords={openRecords} onCloseRecords={closeRecords} onFrame={clearRecord}>
          {hash && <ExploreBridge hash={hash} />}
          {open && <ExploreRecordsPanel records={records} load={load} selected={selection} onSelect={selectRecord} onCenter={(record) => {
            selectRecord(record)
            if (matchMedia('(max-width: 660px)').matches) closeRecords()
          }} onClose={closeRecords} onRetry={retry} focusOnOpen={focus} />}
        </Hud>
      </div>
    </div>
  )
}
