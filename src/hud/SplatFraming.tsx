import { useEffect, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useWorld } from '../app/store.ts'
import {
  applyUpFix,
  captureEntryHere,
  closeFraming,
  resetCrop,
  saveFraming,
  setCrop,
  setCropAxis,
  useFraming,
} from '../world/splats/FramingRig.tsx'
import { useSplatTiers } from '../world/splats/tiers.ts'

// HUD for the splat framing mode (camera mode 'framing', main canvas): numeric crop per axis
// (native splat units; the wireframe handles in the world edit the same draft), up-fix
// quarter turns, "Set entry pose here", Save / Cancel. Plus the "crystallising" bar shown
// while a focused interior loads (fly-in and framing).

const AXES = ['x', 'y', 'z'] as const

function fmt(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(3) : v.toFixed(4)
}

/** A number input that edits locally and commits on Enter / blur (so "-" or "1." can be typed). */
function NumberField({ value, step, label, onCommit }: { value: number; step: number; label: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(fmt(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(fmt(value))
  }, [value, editing])
  const commit = () => {
    setEditing(false)
    const v = Number.parseFloat(text)
    if (Number.isFinite(v)) onCommit(v)
    else setText(fmt(value))
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(false)
      setText(fmt(value))
      e.currentTarget.blur()
    }
  }
  return (
    <input
      type="number"
      aria-label={label}
      step={step}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className="w-full min-w-0 border border-bone/25 bg-void px-1 py-0.5 text-right font-mono text-[11px] tabular-nums text-bone outline-none focus:border-brass"
    />
  )
}

export function SplatFraming() {
  const mode = useApp((s) => s.mode)
  const id = useFraming((s) => s.id)
  if (mode !== 'framing' || !id) return null
  return <FramingPanel id={id} />
}

function FramingPanel({ id }: { id: string }) {
  const title = useWorld((s) => s.nodes.get(id)?.title ?? 'Memory')
  const d = useFraming(
    useShallow((s) => ({
      crop: s.crop,
      bounds: s.bounds,
      upFix: s.upFix,
      entryPose: s.entryPose,
      dirty: s.dirty,
      saving: s.saving,
      error: s.error,
    })),
  )
  const [entrySet, setEntrySet] = useState(false)
  const box = d.crop ?? d.bounds
  const extent = d.bounds ? Math.max(...d.bounds.max.map((v, i) => v - d.bounds!.min[i])) : 1
  const step = Number((Math.max(1e-3, extent / 200)).toPrecision(1))

  return (
    <section
      aria-label="Splat framing"
      className="hud-panel pointer-events-auto absolute bottom-3 left-3 flex w-[min(22rem,calc(100%-1.5rem))] flex-col gap-3 px-3 py-3"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="m-0 truncate text-[11px] font-normal uppercase tracking-[0.14em] text-bone">Framing · {title}</h2>
        <span className="hud-label shrink-0">{d.dirty ? 'edited' : 'saved'}</span>
      </header>

      <CrystalLine id={id} />

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="hud-label">Crop (native units)</span>
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-concrete">
            <input
              type="checkbox"
              checked={d.crop !== null}
              disabled={!d.bounds && d.crop === null}
              onChange={(e) => (e.target.checked ? resetCrop() : setCrop(null))}
            />
            on
          </label>
        </div>
        {box ? (
          <div className="grid grid-cols-[1.2rem_1fr_1fr] items-center gap-x-2 gap-y-1">
            <span />
            <span className="hud-label text-right">min</span>
            <span className="hud-label text-right">max</span>
            {AXES.map((a, i) => (
              <div key={a} className="contents">
                <span className="hud-label">{a}</span>
                <NumberField label={`${a} min`} value={box.min[i]} step={step} onCommit={(v) => setCropAxis(i as 0 | 1 | 2, 'min', v)} />
                <NumberField label={`${a} max`} value={box.max[i]} step={step} onCommit={(v) => setCropAxis(i as 0 | 1 | 2, 'max', v)} />
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-[11px] text-concrete">Waiting for the scene bounds…</p>
        )}
        <div className="flex gap-2">
          <button type="button" className="hud-btn" disabled={!d.bounds} onClick={resetCrop}>
            Reset to scene
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="hud-label">Up-fix</span>
        <div className="flex flex-wrap gap-1">
          <button type="button" className="hud-btn" title="Quarter turn about X" onClick={() => applyUpFix('+x')}>
            X +90°
          </button>
          <button type="button" className="hud-btn" title="Quarter turn back about X" onClick={() => applyUpFix('-x')}>
            X −90°
          </button>
          <button type="button" className="hud-btn" title="Quarter turn about Z" onClick={() => applyUpFix('+z')}>
            Z +90°
          </button>
          <button type="button" className="hud-btn" title="Quarter turn back about Z" onClick={() => applyUpFix('-z')}>
            Z −90°
          </button>
          <button type="button" className="hud-btn" title="Upside down (half turn about X)" onClick={() => applyUpFix('flip')}>
            Flip
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="hud-btn"
          title="Use the current view as the place a fly-in comes to rest"
          onClick={() => setEntrySet(captureEntryHere())}
        >
          Set entry pose here
        </button>
        <span className="hud-label">{entrySet ? 'entry pose set' : 'entry pose unchanged'}</span>
      </div>

      {d.error && (
        <p role="alert" className="m-0 border border-ember/60 px-2 py-1 text-[11px] text-ember">
          {d.error}
        </p>
      )}

      <footer className="flex justify-end gap-2">
        <button type="button" className="hud-btn" onClick={closeFraming} disabled={d.saving}>
          Cancel
        </button>
        <button type="button" className="hud-btn border-brass text-brass" onClick={() => void saveFraming()} disabled={d.saving || !d.dirty}>
          {d.saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </section>
  )
}

function CrystalLine({ id }: { id: string }) {
  const c = useSplatTiers((s) => s.crystal)
  if (c.id !== id || c.phase === 'idle' || c.phase === 'ready') return null
  return <ProgressBar phase={c.phase} progress={c.progress} error={c.error} />
}

function ProgressBar({ phase, progress, error }: { phase: string; progress: number; error?: string }) {
  const failed = phase === 'error'
  return (
    <div className="flex flex-col gap-1" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between">
        <span className="hud-label">{failed ? 'interior failed' : 'crystallising'}</span>
        <span className="text-[10px] tabular-nums text-concrete">{failed ? '' : `${Math.round(progress * 100)}%`}</span>
      </div>
      <div className="h-[3px] w-full bg-bone/10">
        <div className={`h-full ${failed ? 'bg-ember' : 'bg-brass'}`} style={{ width: `${Math.round((failed ? 1 : progress) * 100)}%` }} />
      </div>
      {failed && error && <p className="m-0 text-[10px] text-ember">{error}</p>}
    </div>
  )
}

/**
 * The "crystallising" indicator for a fly-in: shown while the focused interior loads during
 * 'entering' / 'interior'. Mount it in the HUD stage next to the other panels.
 */
export function SplatCrystallising() {
  const mode = useApp((s) => s.mode)
  const c = useSplatTiers((s) => s.crystal)
  if (mode !== 'entering' && mode !== 'interior') return null
  if (!c.id || c.phase === 'idle' || c.phase === 'ready') return null
  return (
    <div className="hud-panel pointer-events-none absolute bottom-3 left-1/2 w-[16rem] -translate-x-1/2 px-3 py-2">
      <ProgressBar phase={c.phase} progress={c.progress} error={c.error} />
    </div>
  )
}
