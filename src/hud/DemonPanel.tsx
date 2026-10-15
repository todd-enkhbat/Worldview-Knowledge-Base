import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { updateNode, useRepoStatus } from '../data/repo.ts'
import type { NodeRecord } from '../domain/types.ts'
import {
  activateDemon,
  compactLog,
  kTEff,
  landauerCost,
  landauerJoules,
  previewCompaction,
  previewDemon,
  startOverlays,
  useOverlaySummary,
} from '../overlay/index.ts'
import type { CompactPreview } from '../overlay/index.ts'
import { BTN, BTN_DANGER, ConfirmDialog } from './DurabilityKit.tsx'
import { selectAndFly } from './shortcuts.ts'

// Demons and the Landauer ledger (useApp panels.demons). Lists the world's demons with their
// live match (M of C candidates, log2(C/M) bits per match), lets the user switch them on and
// off or re-sort, and shows the bits the demons have recorded in the interaction log as
// UNPAID Landauer debt, bits·kT_eff·ln 2. The debt is paid only by erasing the record:
// "compact log" clears events (with confirmation) and books the payment. See overlay/demon.ts.

const YEAR_MS = 365.2425 * 86_400_000

function fmtBits(b: number): string {
  return b >= 1000 ? `${(b / 1000).toFixed(1)}k` : b.toFixed(b < 10 ? 2 : 1)
}

function fmtEnergy(e: number): string {
  return e === 0 ? '0' : e.toPrecision(3)
}

function fmtJoules(j: number): string {
  return j === 0 ? '0 J' : `${(j / 1e-21).toPrecision(3)} zJ`
}

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4" title={title}>
      <dt className="hud-label">{label}</dt>
      <dd className="m-0 text-right tabular-nums">{value}</dd>
    </div>
  )
}

export function DemonPanel() {
  const open = useApp((s) => s.panels.demons)
  if (!open) return null
  return <DemonPanelBody />
}

function DemonPanelBody() {
  useEffect(() => startOverlays(), [])
  const nodes = useWorld((s) => s.nodes)
  const writer = useRepoStatus((s) => s.writer)
  const libraryOpen = useApp((s) => s.panels.library)
  const sum = useOverlaySummary()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const onCompactDone = useCallback((msg: string | null) => {
    setConfirming(false)
    if (msg) setNotice(msg)
  }, [])
  const onCompactError = useCallback((msg: string) => {
    setConfirming(false)
    setError(msg)
  }, [])

  const demons = useMemo(() => [...nodes.values()].filter((n) => n.archetype === 'demon').sort((a, b) => a.title.localeCompare(b.title)), [nodes])
  const kT = useMemo(() => kTEff(nodes.values()), [nodes])
  const debt = landauerCost(sum.bits, kT)

  return (
    <aside
      aria-labelledby="hud-demons-title"
      className={`hud-panel absolute top-0 flex max-h-[calc(100%-0.75rem)] w-[min(22rem,calc(100%-1.5rem))] flex-col ${
        libraryOpen ? 'left-3 sm:left-[calc(min(20rem,100%-1.5rem)+1.5rem)]' : 'left-3'
      }`}
    >
      <header className="flex items-center justify-between border-b border-bone/15 px-3 py-2">
        <h2 id="hud-demons-title" className="m-0 text-[10px] font-normal uppercase tracking-[0.14em] text-bone">
          Demons · Landauer ledger
        </h2>
        <button
          type="button"
          className="px-1 text-concrete hover:text-bone focus-visible:outline-2 focus-visible:outline-signal"
          aria-label="Close demons"
          onClick={() => useApp.getState().togglePanel('demons', false)}
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="m-0 border-b border-bone/15 px-3 py-2 text-[11px] leading-snug text-concrete">
          Plasticity follows real interaction time, not the scrub. Elevation, citadels, mist, synapses and the ledger come from the
          interaction log and the wall clock.
        </p>

        {(error || sum.error) && (
          <p role="alert" className="m-0 border-b border-bone/15 px-3 py-2 text-signal">
            {error ?? sum.error}
          </p>
        )}
        {notice && (
          <p role="status" className="m-0 border-b border-bone/15 px-3 py-2 text-bone">
            {notice}
          </p>
        )}

        <section aria-labelledby="hud-demons-ledger" className="border-b border-bone/15 px-3 py-2">
          <h3 id="hud-demons-ledger" className="hud-label m-0 mb-1">
            Ledger
          </h3>
          {!sum.loaded ? (
            <p className="m-0 text-concrete">Reading the log…</p>
          ) : (
            <dl className="m-0 space-y-0.5">
              <Stat label="Recorded" value={`${fmtBits(sum.bits)} bit · ${sum.demonEvents} ev`} title="Σ bits of the demon-match events in the log (the demons' memory)" />
              <Stat label="kT_eff" value={kT.toFixed(3)} title="Mean node temperature, in world energy units (thermal speed √(T/m))" />
              <Stat
                label="Unpaid debt"
                value={<span className={sum.bits > 0 ? 'text-ember' : ''}>{fmtEnergy(debt)}</span>}
                title={`bits·kT_eff·ln 2 in world energy units (the Timeline ΔE units). At 300 K: ${fmtJoules(landauerJoules(sum.bits))}`}
              />
              <Stat label="Paid" value={`${fmtBits(sum.paid.bits)} bit · ${fmtEnergy(sum.paid.cost)}`} title={`${sum.paid.compactions} compaction(s), ${sum.paid.events} events erased; ${fmtJoules(sum.paid.joules)} at 300 K`} />
              <Stat label="Log" value={`${sum.events} ev · ${sum.synapses} syn`} />
            </dl>
          )}
          <button
            type="button"
            className={`${BTN_DANGER} mt-2 w-full`}
            disabled={!writer || !sum.loaded || sum.events === 0}
            title={writer ? 'Erase interaction events and pay the recorded bits' : 'Read-only: another tab is the writer'}
            onClick={() => {
              setError(null)
              setNotice(null)
              setConfirming(true)
            }}
          >
            Compact log (pay the debt)
          </button>
        </section>

        <section aria-labelledby="hud-demons-list" className="px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <h3 id="hud-demons-list" className="hud-label m-0">
              Demons ({demons.length})
            </h3>
            <button
              type="button"
              className={BTN}
              disabled={!writer}
              onClick={() => useApp.getState().openEditor({ nodeId: null, archetype: 'demon' })}
            >
              + Demon
            </button>
          </div>
          {demons.length === 0 ? (
            <p className="m-0 text-concrete">No demons yet. A demon is a standing query that sorts matching nodes within its radius onto a lattice.</p>
          ) : (
            <ul className="m-0 list-none space-y-2 p-0">
              {demons.map((d) => (
                <DemonRow key={d.id} demon={d} writer={writer} nodes={nodes} onError={setError} onNotice={setNotice} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {confirming && <CompactDialog kT={kT} onDone={onCompactDone} onError={onCompactError} />}
    </aside>
  )
}

function DemonRow({
  demon,
  writer,
  nodes,
  onError,
  onNotice,
}: {
  demon: NodeRecord
  writer: boolean
  nodes: ReadonlyMap<string, NodeRecord>
  onError: (m: string) => void
  onNotice: (m: string) => void
}) {
  const d = demon.demon
  const entry = useOverlaySummary((s) => s.perDemon[demon.id])
  // previewDemon reads the same records; `nodes` keeps the memo honest.
  const match = useMemo(() => (nodes.has(demon.id) ? previewDemon(demon.id) : null), [nodes, demon.id])
  const [busy, setBusy] = useState(false)
  if (!d) return null

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="border border-bone/15 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <button type="button" className="truncate text-left text-bone hover:underline focus-visible:outline-2 focus-visible:outline-signal" onClick={() => selectAndFly(demon.id)}>
          ✶ {demon.title || 'Untitled demon'}
        </button>
        <label className="flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-wider text-concrete">
          <input
            type="checkbox"
            className="accent-signal"
            checked={d.active}
            disabled={!writer || busy}
            onChange={() => run(() => updateNode(demon.id, { demon: { ...d, active: !d.active } }))}
          />
          Active
        </label>
      </div>
      <dl className="m-0 mt-1 space-y-0.5">
        <Stat label="Query" value={<span className="break-all">{d.query.trim() || '—'}</span>} />
        <Stat label="Radius" value={`${d.radius} u`} />
        <Stat
          label="Match"
          value={match ? `${match.hits.length} / ${match.candidates} · ${fmtBits(match.bitsPerMatch)} bit` : '—'}
          title="M matched of C candidates within the radius; each match records log2(C/M) bits"
        />
        <Stat label="Recorded" value={entry ? `${fmtBits(entry.bits)} bit · ${entry.events} ev` : '0'} />
      </dl>
      <button
        type="button"
        className={`${BTN} mt-1.5`}
        disabled={!writer || busy || !match || match.hits.length === 0}
        title="Measure again: logs one demon-match per matched node and replays the 2 s lattice easing"
        onClick={() =>
          run(async () => {
            const r = await activateDemon(demon.id)
            if (r) onNotice(`Sorted ${r.logged} node(s): +${fmtBits(r.logged * r.match.bitsPerMatch)} bit recorded.`)
          })
        }
      >
        Sort again
      </button>
    </li>
  )
}

function CompactDialog({ kT, onDone, onError }: { kT: number; onDone: (msg: string | null) => void; onError: (m: string) => void }) {
  const [scope, setScope] = useState<'old' | 'all'>('old')
  const [preview, setPreview] = useState<CompactPreview | null>(null)
  const [busy, setBusy] = useState(false)
  // A stable cutoff for the dialog's lifetime, so the preview and the erase agree.
  const [cutoff] = useState(() => Date.now() - YEAR_MS)
  const before = scope === 'old' ? cutoff : undefined

  useEffect(() => {
    let live = true
    setPreview(null)
    previewCompaction(before)
      .then((p) => live && setPreview(p))
      .catch((e) => live && onError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [before, onError])

  const onConfirm = async () => {
    setBusy(true)
    try {
      const r = await compactLog({ confirm: true, before })
      onDone(`Erased ${r.events} event(s); paid ${fmtBits(r.bits)} bit = ${fmtEnergy(r.cost)} (${fmtJoules(r.joules)} at 300 K).`)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <ConfirmDialog title="Compact the interaction log" confirmLabel="Erase and pay" danger busy={busy} onConfirm={onConfirm} onCancel={() => onDone(null)}>
      <fieldset className="m-0 space-y-1 border-0 p-0">
        <legend className="hud-label mb-1">Erase</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="compact-scope" className="mt-1 accent-signal" checked={scope === 'old'} onChange={() => setScope('old')} />
          <span>Events older than one year. Their traces have long decayed and their pull on today's synapse weights is under 0.02, so nothing visible changes.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="compact-scope" className="mt-1 accent-signal" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>The entire log. Plasticity resets: elevation, citadels, mist and synapses start over.</span>
        </label>
      </fieldset>
      <p className="m-0">
        {preview
          ? `${preview.events} event(s), ${fmtBits(preview.bits)} recorded bit. Landauer cost bits·kT_eff·ln 2 = ${fmtEnergy(preview.cost)} at kT_eff ${kT.toFixed(3)} (${fmtJoules(preview.joules)} at 300 K).`
          : 'Counting…'}
      </p>
      <p className="m-0 text-concrete">Erasing cannot be undone. An export made before now still contains the events.</p>
    </ConfirmDialog>
  )
}
