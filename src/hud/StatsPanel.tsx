import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../app/store.ts'
import { useRenderStats } from '../world/renderStats.ts'

// Renderer stats (toggle with `). Reads the 4 Hz snapshot, never the per-frame liveStats.

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

const ms = (v: number) => v.toFixed(1)

export function StatsPanel() {
  const open = useApp((s) => s.panels.stats)
  if (!open) return null
  return <StatsBody />
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="hud-label">{label}</dt>
      <dd className="m-0 tabular-nums">
        {value}
        {unit && <span className="ml-1 text-concrete">{unit}</span>}
      </dd>
    </div>
  )
}

function StatsBody() {
  const r = useRenderStats(
    useShallow((s) => ({
      fps: s.fps,
      frameMs: s.frameMs,
      cpuMs: s.cpuMs,
      calls: s.calls,
      triangles: s.triangles,
      points: s.points,
      lines: s.lines,
      geometries: s.geometries,
      textures: s.textures,
      programs: s.programs,
      samples: s.samples,
    })),
  )
  const q = useApp((s) => s.quality)
  const inspectorOpen = useApp((s) => s.panels.inspector && s.selectedId !== null)

  return (
    <aside
      aria-label="Renderer stats"
      className={`hud-panel absolute bottom-3 w-[13.5rem] px-3 py-2 ${inspectorOpen ? 'right-3 sm:right-[calc(min(24rem,100%-1.5rem)+1.5rem)]' : 'right-3'}`}
    >
      <header className="mb-1 flex items-center justify-between">
        <h2 className="m-0 text-[10px] font-normal uppercase tracking-[0.14em] text-bone">Renderer</h2>
        <button
          type="button"
          className="px-1 text-concrete hover:text-bone focus-visible:outline-2 focus-visible:outline-signal"
          aria-label="Close stats"
          onClick={() => useApp.getState().togglePanel('stats', false)}
        >
          ×
        </button>
      </header>
      {r.samples === 0 ? (
        <p className="m-0 text-concrete">No frames yet.</p>
      ) : (
        <dl className="m-0 space-y-0.5">
          <Stat label="FPS" value={r.fps.toFixed(0)} />
          <Stat label="Frame p50/95" value={`${ms(r.frameMs.p50)}/${ms(r.frameMs.p95)}`} unit="ms" />
          <Stat label="CPU p50/95" value={`${ms(r.cpuMs.p50)}/${ms(r.cpuMs.p95)}`} unit="ms" />
          <Stat label="Calls" value={compact(r.calls)} />
          <Stat label="Triangles" value={compact(r.triangles)} />
          {r.points > 0 && <Stat label="Points" value={compact(r.points)} />}
          {r.lines > 0 && <Stat label="Lines" value={compact(r.lines)} />}
          <Stat label="Geometries" value={compact(r.geometries)} />
          <Stat label="Textures" value={compact(r.textures)} />
          <Stat label="Programs" value={compact(r.programs)} />
        </dl>
      )}
      <dl className="m-0 mt-2 space-y-0.5 border-t border-bone/15 pt-2">
        <Stat label="Tier" value={q.tier} />
        <Stat label="DPR" value={q.dpr.toFixed(2)} />
        <Stat label="Reflector" value={q.reflector} />
        <Stat label="Splat LoD" value={compact(q.lodSplatCount)} />
      </dl>
    </aside>
  )
}
