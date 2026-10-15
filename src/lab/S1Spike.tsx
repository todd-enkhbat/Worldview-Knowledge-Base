import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { AgXToneMapping, Color } from 'three'
import { collect, runS1, type S1RunOptions } from './s1/bench.ts'
import { estimateVsync, percentiles, shareAbove } from './s1/metrics.ts'
import { S1Scene } from './s1/scene.tsx'
import { rt, useS1, type DioramaMode, type ProxyMethod, type Toggles } from './s1/state.ts'

// #/lab/s1 — the S1 Spark spike (PLAN Phase 0). Toggle each feature to bisect frame-time
// problems; "run 20 s" (or window.__s1() in dev) drives the scripted path and returns JSON.

declare global {
  interface Window {
    __s1?: ((opts?: S1RunOptions) => Promise<Record<string, unknown>>) & {
      snapshot: () => Record<string, unknown>
      set: (patch: Partial<Toggles>) => void
      hud: (on: boolean) => void
      view: (pos: [number, number, number], target: [number, number, number]) => void
    }
  }
}

const BOOL_TOGGLES: [keyof Toggles, string][] = [
  ['reflector', 'reflector floor'],
  ['post', 'composer + bloom'],
  ['depthView', 'depth view (post)'],
  ['points', '100k points'],
  ['movingLod', 'moving LoD mesh (#347)'],
  ['tween', 'proxy scale tween'],
  ['forceSinglePass', 'forceSinglePass'],
  ['depthProxy', 'depth proxies'],
  ['depthProxyEarly', '✗ depth proxy early'],
  ['leakSplats', '✗ splats on layer 0'],
]

export default function S1Spike() {
  useEffect(() => {
    const fn = Object.assign((opts?: S1RunOptions) => runS1(opts), {
      snapshot: () => collect('snapshot', rt.ring.count * 16.7),
      set: (patch: Partial<Toggles>) => useS1.getState().set(patch),
      hud: (on: boolean) => useS1.getState().setHud(on),
      view: (pos: [number, number, number], target: [number, number, number]) => {
        useS1.getState().set({ path: 'manual' })
        rt.camera?.position.set(...pos)
        rt.controls?.target.set(...target)
        rt.controls?.update()
      },
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'h' || e.key === 'H') useS1.getState().setHud(!useS1.getState().hud)
    }
    window.addEventListener('keydown', onKey)
    window.__s1 = fn
    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          rt.longTasks.count++
          rt.longTasks.totalMs += Math.round(e.duration)
        }
      })
      observer.observe({ type: 'longtask', buffered: false })
    } catch {
      observer = null // Safari / Firefox have no longtask entries
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      observer?.disconnect()
      if (window.__s1 === fn) delete window.__s1
    }
  }, [])

  return (
    <div className="relative h-full w-full bg-void">
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, depth: true }}
        camera={{ fov: 50, near: 0.1, far: 600, position: [0, 6, 22] }}
        onCreated={({ gl }) => {
          gl.info.autoReset = false
          gl.toneMapping = AgXToneMapping
          gl.setClearColor(new Color('#0b0b0c'), 1)
        }}
      >
        <S1Scene />
      </Canvas>
      <Hud />
    </div>
  )
}

function Hud() {
  const hud = useS1((s) => s.hud)
  const setHud = useS1((s) => s.setHud)
  if (!hud)
    return (
      <button className="hud-btn absolute left-3 top-3 bg-void/85" onClick={() => setHud(true)}>
        s1 · show (h)
      </button>
    )
  return (
    <>
      <TogglePanel />
      <StatsPanel />
    </>
  )
}

function TogglePanel() {
  const toggles = useS1((s) => s.toggles)
  const set = useS1((s) => s.set)
  const bench = useS1((s) => s.benchRunning)
  const [json, setJson] = useState<string | null>(null)
  const run = async (path: 'orbit' | 'static') => {
    setJson(null)
    const r = await runS1({ path })
    const text = JSON.stringify(r, null, 2)
    setJson(text)
    console.info('[s1]', r)
  }
  return (
    <div className="hud-panel absolute left-3 top-3 max-h-[calc(100%-24px)] w-[220px] overflow-auto p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between">
        <span className="hud-label">s1 · spark spike</span>
        <button className="hud-label hover:text-bone" onClick={() => useS1.getState().setHud(false)}>
          hide (h)
        </button>
      </div>
      {BOOL_TOGGLES.map(([key, label]) => (
        <label key={key} className="flex cursor-pointer items-center gap-2 py-[2px]">
          <input type="checkbox" checked={toggles[key] as boolean} onChange={(e) => set({ [key]: e.target.checked })} />
          <span>{label}</span>
        </label>
      ))}
      <div className="hud-label mb-1 mt-2">dioramas</div>
      <div className="flex gap-1">
        {(['lod', 'proxy', 'both'] as DioramaMode[]).map((m) => (
          <button key={m} className={`hud-btn ${toggles.dioramaMode === m ? 'bg-bone text-void' : ''}`} onClick={() => set({ dioramaMode: m })}>
            {m}
          </button>
        ))}
      </div>
      <div className="hud-label mb-1 mt-2">proxy method</div>
      <div className="flex gap-1">
        {(['cut', 'level', 'subsample'] as ProxyMethod[]).map((m) => (
          <button key={m} className={`hud-btn ${toggles.proxyMethod === m ? 'bg-bone text-void' : ''}`} onClick={() => set({ proxyMethod: m })}>
            {m}
          </button>
        ))}
      </div>
      <div className="hud-label mb-1 mt-2">measure (20 s)</div>
      <div className="flex gap-1">
        <button className="hud-btn" disabled={!!bench} onClick={() => void run('orbit')}>
          orbit
        </button>
        <button className="hud-btn" disabled={!!bench} onClick={() => void run('static')}>
          static
        </button>
        {json && (
          <button className="hud-btn" onClick={() => void navigator.clipboard?.writeText(json)}>
            copy json
          </button>
        )}
      </div>
      {bench && <div className="mt-2 text-brass">running: {bench}</div>}
      {json && <pre className="mt-2 max-h-[200px] overflow-auto text-[10px] leading-tight text-concrete">{json}</pre>}
    </div>
  )
}

interface Live {
  fps: number
  vsync: number
  iv: ReturnType<typeof percentiles>
  main: ReturnType<typeof percentiles>
  slow: number
  active: number
  sortsPerSec: number
  sortP50: number
  calls: number
  draws: string
  gpu: ReturnType<typeof percentiles> | null
}

const WINDOW = 240

function StatsPanel() {
  const dioramas = useS1((s) => s.dioramas)
  const [live, setLive] = useState<Live | null>(null)
  useEffect(() => {
    let lastSorts = 0
    let lastT = performance.now()
    const id = setInterval(() => {
      const iv = rt.ring.select('interval', 0, 0, WINDOW)
      const mn = rt.ring.select('main', 0, 0, WINDOW)
      const vsync = estimateVsync(iv)
      const p = percentiles(iv)
      const now = performance.now()
      const sorts = rt.probe?.sorts.total ?? 0
      const sortsPerSec = ((sorts - lastSorts) * 1000) / Math.max(1, now - lastT)
      lastSorts = sorts
      lastT = now
      setLive({
        fps: p.mean > 0 ? 1000 / p.mean : 0,
        vsync,
        iv: p,
        main: percentiles(mn),
        slow: shareAbove(iv, 1.5 * vsync),
        active: rt.spark?.activeSplats ?? 0,
        sortsPerSec,
        sortP50: rt.probe?.sorts.summary().p50 ?? 0,
        calls: rt.lastInfo.calls,
        draws: `${rt.draws.main}/${rt.draws.other}`,
        gpu: rt.gpu.total > 0 ? rt.gpu.summary() : null,
      })
    }, 250)
    return () => clearInterval(id)
  }, [])
  const f = (x: number, d = 1) => x.toFixed(d)
  return (
    <div className="hud-panel absolute bottom-3 right-3 max-h-[calc(100%-24px)] w-[280px] overflow-auto p-2 text-[11px]">
      <div className="hud-label mb-1">frame · last {WINDOW}</div>
      {live && (
        <div className="grid grid-cols-[1fr_auto] gap-x-3 leading-5">
          <span>fps · vsync</span>
          <span>
            {f(live.fps)} · {f(live.vsync, 2)} ms
          </span>
          <span>rAF p50/95/99</span>
          <span>
            {f(live.iv.p50)}/{f(live.iv.p95)}/{f(live.iv.p99)}
          </span>
          <span>main p50/95/99</span>
          <span>
            {f(live.main.p50)}/{f(live.main.p95)}/{f(live.main.p99)}
          </span>
          <span>gpu p50/95/99</span>
          <span>{live.gpu ? `${f(live.gpu.p50)}/${f(live.gpu.p95)}/${f(live.gpu.p99)}` : 'n/a'}</span>
          <span>&gt;1.5× vsync</span>
          <span>{f(live.slow * 100)} %</span>
          <span>splats (sorted)</span>
          <span>{live.active.toLocaleString()}</span>
          <span>sorts/s · p50</span>
          <span>
            {f(live.sortsPerSec)} · {f(live.sortP50)} ms
          </span>
          <span>draw calls</span>
          <span>{live.calls}</span>
          <span>spark draws main/other</span>
          <span>{live.draws}</span>
        </div>
      )}
      <div className="hud-label mb-1 mt-3">dioramas</div>
      {dioramas.map((d, i) => (
        <div key={i} className="mb-1 leading-4">
          <div className="text-bone">
            {d.name} <span className="text-concrete">· {d.status}</span>
          </div>
          {d.splats !== undefined && (
            <div className="text-[10px] text-concrete">
              {d.splats.toLocaleString()} splats · lod {d.lodSplats?.toLocaleString()} · load {d.loadMs} ms
              {d.convertMs !== undefined && ` · v4→v3 ${d.convertMs} ms`}
            </div>
          )}
          {Object.values(d.proxies).map((p) => (
            <div key={p.method} className="text-[10px] text-concrete">
              {p.method}
              {p.level !== undefined && ` L${p.level}`}: {p.splats.toLocaleString()} · {p.selectMs}+{p.writeMs} ms · {(p.bytes / 1e6).toFixed(1)} MB
              {p.coverage && ` · cov ${p.coverage.cells}/${p.coverage.mass}`}
            </div>
          ))}
          {d.error && <div className="text-[10px] text-ember">{d.error}</div>}
        </div>
      ))}
    </div>
  )
}
