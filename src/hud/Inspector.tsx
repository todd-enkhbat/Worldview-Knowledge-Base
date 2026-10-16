import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { canTransition, useApp, useWorld } from '../app/store.ts'
import { logEvent, useRepoStatus } from '../data/repo.ts'
import { memoryLabel, memoryOrdinal } from '../domain/memoryIndex.ts'
import { formatByPrecision } from '../domain/time.ts'
import type { Archetype, Attachment, LinkKind, NodeRecord } from '../domain/types.ts'
import { flyTo } from '../world/camera/flyTo.ts'
import { useIngestJobs } from '../world/splats/ingest/jobs.ts'
import { ArchetypeGlyph } from './ArchetypePicker.tsx'
import { HudDialog } from './DurabilityKit.tsx'
import { significanceWord, volatilityWord } from './fields/helpers.ts'
import { IngestProgressBar, SceneThumb, formatCount, useStoredBlobUrl } from './fields/SceneField.tsx'
import { Markdown } from './markdown.ts'
import { deleteNode, editNode, openPalette, selectAndFly } from './shortcuts.ts'

// Right-hand panel for the selected node. Read-only view plus the node's actions; editing
// happens in NodeEditor.

const GLYPH: Readonly<Record<Archetype, string>> = {
  idea: '◆', //     faceted crystal
  entity: '▮', //   monolith
  lens: '◎', //     astrolabe
  document: '▤', // slab with text
  memory: '⧈', //   tesseract: a cube inside a cube
  demon: '✶',
}

const GLYPH_COLOR: Readonly<Record<Archetype, string>> = {
  idea: 'text-glass',
  entity: 'text-bone',
  lens: 'text-brass',
  document: 'text-concrete',
  memory: 'text-ember',
  demon: 'text-bone',
}

/** Archetype mark. Decorative: pair it with visible text (the archetype or title). */
export function NodeGlyph({ archetype, className = '' }: { archetype: Archetype; className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-block w-[1.25em] text-center ${GLYPH_COLOR[archetype]} ${className}`}>
      {GLYPH[archetype]}
    </span>
  )
}

const LINK_VERB: Readonly<Record<LinkKind, string>> = {
  relates: 'relates to',
  supports: 'supports',
  contradicts: 'contradicts',
  derives: 'derives from',
  'influenced-by': 'influenced by',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// logEvent('inspect') once per selection. Module-level so StrictMode's double effect and
// remounts of the panel do not log twice; reset on deselect so re-selecting counts again.
let lastInspected: string | null = null

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1">
      <dt className="hud-label pt-[2px]">{label}</dt>
      <dd className="m-0 break-words">{children}</dd>
    </div>
  )
}

export function Inspector() {
  const selectedId = useApp((s) => s.selectedId)
  const open = useApp((s) => s.panels.inspector)

  useEffect(() => {
    if (selectedId === lastInspected) return
    lastInspected = selectedId
    // Deferred so a not-ready repo (which throws synchronously) becomes a dropped event.
    if (selectedId) Promise.resolve(selectedId).then((id) => logEvent('inspect', id)).catch(() => {})
  }, [selectedId])

  if (!open || !selectedId) return null
  return <InspectorPanel id={selectedId} />
}

function InspectorPanel({ id }: { id: string }) {
  const nodes = useWorld((s) => s.nodes)
  const trash = useWorld((s) => s.trash)
  const writer = useRepoStatus((s) => s.writer)
  const node = nodes.get(id)

  const ordinal = useMemo(() => memoryOrdinal(nodes, id), [nodes, id])
  const backlinks = useMemo(() => {
    const out: { from: NodeRecord; kind: LinkKind }[] = []
    for (const n of nodes.values()) for (const l of n.links) if (l.targetId === id) out.push({ from: n, kind: l.kind })
    return out
  }, [nodes, id])

  if (!node) return null
  const readOnly = !writer
  const kicker = node.archetype === 'memory' ? memoryLabel(ordinal) : node.archetype.toUpperCase()
  const ref = node.referenceDate

  return (
    <aside
      aria-labelledby="hud-inspector-title"
      className="hud-panel absolute right-3 top-0 flex max-h-[calc(100%-0.75rem)] w-[min(24rem,calc(100%-1.5rem))] flex-col"
    >
      <header className="flex items-center gap-3 border-b border-bone/20 px-4 py-2">
        <span className={GLYPH_COLOR[node.archetype]}>
          <ArchetypeGlyph archetype={node.archetype} className="h-7 w-7" />
        </span>
        <span className="flex-1 text-[10px] uppercase tracking-[0.14em] text-bone">{kicker}</span>
        <button
          type="button"
          className="hud-btn focus-visible:outline-2 focus-visible:outline-signal"
          aria-label="Close inspector"
          onClick={() => useApp.getState().select(null)}
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <h2 id="hud-inspector-title" className="m-0 mb-4 font-sans text-[20px] font-semibold leading-tight text-bone">
          {node.title}
        </h2>

        <dl className="m-0 mb-4 border-y border-bone/10 py-2">
          <Row label="Entered">
            {formatByPrecision(node.temporalOrigin, node.temporalPrecision)}
            <span className="ml-2 text-concrete">/{node.temporalPrecision}</span>
          </Row>
          {ref && (
            <Row label="Reference">
              {formatByPrecision(ref.epochMs, ref.precision)}
              {ref.label && <span className="ml-2 text-concrete">{ref.label}</span>}
            </Row>
          )}
          <Row label="Significance">
            {significanceWord(node.thermo.mass)}
            <span className="ml-2 text-concrete">m={node.thermo.mass.toFixed(2)}</span>
          </Row>
          <Row label="Volatility">
            {volatilityWord(node.thermo.temperature)}
            <span className="ml-2 text-concrete">τ={node.thermo.temperature.toFixed(2)}</span>
          </Row>
          {node.entity && <Row label="Kind">{node.entity.kind}</Row>}
          {node.demon && (
            <Row label="Demon">
              <span className="break-all">“{node.demon.query}”</span>
              <span className="ml-2 text-concrete">
                r={node.demon.radius} {node.demon.active ? 'active' : 'idle'}
              </span>
            </Row>
          )}
          <Row label="Visibility">{node.visibility}</Row>
        </dl>

        {node.tags.length > 0 && (
          <ul aria-label="Tags" className="m-0 mb-4 flex list-none flex-wrap gap-1 p-0">
            {node.tags.map((t) => (
              <li key={t} className="border border-bone/25 px-1.5 py-0.5 text-[11px] text-bone/80">
                #{t}
              </li>
            ))}
          </ul>
        )}

        {node.contentMd.trim() ? (
          <section aria-label="Content" className="mb-5 text-[12px] leading-relaxed">
            <Markdown source={node.contentMd} />
          </section>
        ) : (
          <p className="mb-5 text-concrete">No content.</p>
        )}

        {(node.links.length > 0 || backlinks.length > 0) && (
          <section aria-labelledby="hud-inspector-links" className="mb-5">
            <h3 id="hud-inspector-links" className="hud-label m-0 mb-2">
              Links
            </h3>
            <ul className="m-0 list-none space-y-1 p-0">
              {node.links.map((l) => {
                const target = nodes.get(l.targetId)
                const trashed = !target ? trash.get(l.targetId) : undefined
                return (
                  <li key={`out-${l.targetId}-${l.kind}`}>
                    <LinkButton verb={LINK_VERB[l.kind]} label={l.label} target={target ?? null} fallback={trashed ? `${trashed.title} (in trash)` : 'missing node'} />
                  </li>
                )
              })}
              {backlinks.map(({ from, kind }) => (
                <li key={`in-${from.id}-${kind}`}>
                  <LinkButton verb={`← ${LINK_VERB[kind]}`} target={from} fallback="missing node" />
                </li>
              ))}
            </ul>
          </section>
        )}

        {node.archetype === 'memory' && <SceneSection node={node} />}

        {node.attachments.length > 0 && <AttachmentsSection attachments={node.attachments} />}
      </div>

      <footer className="grid grid-cols-4 gap-px border-t border-bone/20 bg-bone/20">
        <ActionButton disabled={readOnly} onClick={() => editNode(id)}>
          Edit
        </ActionButton>
        <ActionButton onClick={() => flyTo(id)}>Fly to</ActionButton>
        <ActionButton disabled={readOnly || nodes.size < 2} onClick={() => openPalette({ linkFrom: id })}>
          Link to…
        </ActionButton>
        <ActionButton danger disabled={readOnly} onClick={() => void deleteNode(id)}>
          Delete
        </ActionButton>
      </footer>
      {readOnly && <p className="m-0 border-t border-bone/20 px-4 py-2 text-concrete">Read-only: another tab is the writer.</p>}
    </aside>
  )
}

// ─── volumetric scene (memories) ────────────────────────────────────────────────────

function SceneSection({ node }: { node: NodeRecord }) {
  const job = useIngestJobs((s) => s.jobs[node.id])
  const mode = useApp((s) => s.mode)
  const splat = node.splat
  if (job?.running) {
    return (
      <section aria-label="Volumetric scene" className="mb-5">
        <h3 className="hud-label m-0 mb-2">Volumetric scene</h3>
        <IngestProgressBar job={job} />
      </section>
    )
  }
  if (!splat) return null
  const canEnter = canTransition(mode, 'entering') && mode !== 'entering'
  const enter = () => {
    const app = useApp.getState()
    app.focus(node.id)
    app.setMode('entering')
  }
  return (
    <section aria-labelledby="hud-inspector-scene" className="mb-5">
      <h3 id="hud-inspector-scene" className="hud-label m-0 mb-2">
        Volumetric scene
      </h3>
      <div className="flex gap-3">
        <SceneThumb splat={splat} className="h-28 w-28" />
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
          <p className="m-0 text-[11px] text-concrete">
            {formatCount(splat.counts.interior)} splats · <span className="uppercase">{splat.sourceFormat}</span>
          </p>
          <button
            type="button"
            disabled={!canEnter}
            onClick={enter}
            className="hud-btn self-start focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-40"
            title={canEnter ? 'Fly into the diorama' : `Not available in ${mode.replace('_', ' ')} mode`}
          >
            Enter
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── attachments: image cards + lightbox ─────────────────────────────────────────────

function AttachmentsSection({ attachments }: { attachments: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null)
  const images = attachments.filter((a) => a.kind === 'image')
  const others = attachments.filter((a) => a.kind !== 'image')
  return (
    <section aria-labelledby="hud-inspector-attachments" className="mb-5">
      <h3 id="hud-inspector-attachments" className="hud-label m-0 mb-2">
        Attachments
      </h3>
      {images.length > 0 && (
        <ul className="m-0 mb-2 grid list-none grid-cols-2 gap-2 p-0">
          {images.map((a) => (
            <li key={a.id}>
              <ImageCard attachment={a} onOpen={() => setOpen(a)} />
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="m-0 list-none space-y-1 p-0">
          {others.map((a) => (
            <li key={a.id} className="flex gap-2">
              <span className="hud-label w-10 shrink-0 pt-[2px]">{a.kind}</span>
              <span className="min-w-0 flex-1 truncate" title={a.name}>
                {a.name}
              </span>
              <span className="shrink-0 text-concrete">{formatBytes(a.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && <Lightbox attachment={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

function ImageCard({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  // Thumbnails are ≤ 256 px webp; very old attachments without one fall back to the original.
  const url = useStoredBlobUrl(attachment.thumbBlobId ?? attachment.blobId)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${attachment.name}`}
      className="group flex w-full flex-col border border-bone/20 bg-void text-left hover:border-bone/60 focus-visible:outline-2 focus-visible:outline-signal"
    >
      {url ? (
        <img src={url} alt="" className="aspect-square w-full object-cover" />
      ) : (
        <span className="flex aspect-square w-full items-center justify-center text-[9px] uppercase text-concrete" aria-hidden="true">
          img
        </span>
      )}
      <span className="flex gap-1 border-t border-bone/15 px-1.5 py-1 text-[10px]">
        <span className="min-w-0 flex-1 truncate text-bone" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="shrink-0 text-concrete">{formatBytes(attachment.bytes)}</span>
      </span>
    </button>
  )
}

function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const url = useStoredBlobUrl(attachment.blobId)
  return (
    <HudDialog title={attachment.name} onClose={onClose} width="max-w-5xl">
      <div className="flex min-h-40 items-center justify-center p-3" onClick={onClose}>
        {url ? (
          <img src={url} alt={attachment.name} className="max-h-[80vh] max-w-full object-contain" />
        ) : (
          <p className="m-0 font-mono text-[11px] text-concrete">Loading…</p>
        )}
      </div>
      <p className="m-0 border-t border-bone/15 px-5 py-2 font-mono text-[10px] text-concrete">
        {attachment.mime} · {formatBytes(attachment.bytes)}
      </p>
    </HudDialog>
  )
}

function LinkButton({ verb, label, target, fallback }: { verb: string; label?: string; target: NodeRecord | null; fallback: string }) {
  if (!target) {
    return (
      <span className="flex gap-2 text-concrete">
        <span className="hud-label w-24 shrink-0 pt-[2px]">{verb}</span>
        <span className="line-through">{fallback}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => selectAndFly(target.id)}
      className="flex w-full gap-2 border border-transparent px-1 py-0.5 text-left hover:border-bone/30 focus-visible:outline-2 focus-visible:outline-signal"
    >
      <span className="hud-label w-24 shrink-0 pt-[2px]">{verb}</span>
      <NodeGlyph archetype={target.archetype} />
      <span className="min-w-0 flex-1 truncate">
        {target.title}
        {label && <span className="ml-2 text-concrete">{label}</span>}
      </span>
    </button>
  )
}

function ActionButton({
  children,
  onClick,
  disabled = false,
  danger = false,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`bg-void px-2 py-2.5 font-mono text-[11px] uppercase tracking-wider focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal disabled:opacity-40 ${
        danger ? 'text-signal hover:bg-signal hover:text-void disabled:hover:bg-void disabled:hover:text-signal' : 'text-bone hover:bg-bone hover:text-void disabled:hover:bg-void disabled:hover:text-bone'
      }`}
    >
      {children}
    </button>
  )
}
