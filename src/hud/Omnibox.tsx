import { useEffect, useRef, useState } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import type { NodeRecord } from '../domain/types.ts'
import { SPAWN_BUDGET_MS, submitOmnibox, useOmnibox } from '../ai/omnibox.ts'
import { searchSemantic, useSemantic } from '../ai/semanticIndex.ts'
import { BTN, BTN_PRIMARY, HudDialog } from './DurabilityKit.tsx'
import { selectAndFly } from './shortcuts.ts'

// Omnibox ("/"): one line in, either a jump to what already exists (title matches at once,
// semantic matches once the index is on) or, on Enter, a new node: spawned provisionally at
// once, then refined by Claude. The result list never blocks typing.

interface Hit {
  node: NodeRecord
  score: number
  why: 'title' | 'meaning'
}

function titleHits(nodes: Iterable<NodeRecord>, q: string): Hit[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  const out: Hit[] = []
  for (const n of nodes) {
    const t = n.title.toLowerCase()
    const i = t.indexOf(needle)
    if (i >= 0) out.push({ node: n, score: 2 - i / Math.max(1, t.length), why: 'title' })
    else if (n.tags.some((tag) => tag.includes(needle))) out.push({ node: n, score: 1, why: 'title' })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6)
}

function OmniboxPanel() {
  const nodes = useWorld((s) => s.nodes)
  const writer = useRepoStatus((s) => s.writer)
  const semantic = useSemantic((s) => s.phase)
  const [text, setText] = useState('')
  const [semHits, setSemHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const close = () => useApp.getState().togglePanel('omnibox', false)

  useEffect(() => {
    const q = text.trim()
    if (semantic !== 'ready' || q.length < 3) {
      setSemHits([])
      return
    }
    let live = true
    const t = setTimeout(() => {
      searchSemantic(q, 6)
        .then((hs) => {
          if (!live) return
          const w = useWorld.getState().nodes
          setSemHits(hs.flatMap((h) => (w.has(h.id) && h.similarity > 0.35 ? [{ node: w.get(h.id)!, score: h.similarity, why: 'meaning' as const }] : [])))
        })
        .catch(() => {})
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [text, semantic])

  const fromTitles = titleHits(nodes.values(), text)
  const seen = new Set(fromTitles.map((h) => h.node.id))
  const hits = [...fromTitles, ...semHits.filter((h) => !seen.has(h.node.id))].slice(0, 8)

  const submit = async () => {
    if (!text.trim() || busy || !writer) return
    setBusy(true)
    setError(null)
    try {
      await submitOmnibox(text)
      setText('')
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <HudDialog title="Add to the world" onClose={close} width="max-w-2xl" initialFocus={input}>
      <div className="flex flex-col gap-3 px-5 py-4">
        <textarea
          ref={input}
          rows={2}
          value={text}
          disabled={!writer}
          placeholder={writer ? 'A thought, a memory, a book, a person… (Enter adds it; #tags and years are understood)' : 'Read-only tab'}
          className="w-full resize-none border border-bone/25 bg-void px-3 py-2 font-mono text-[13px] text-bone outline-none focus:border-signal"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="flex items-center justify-between gap-3 text-[11px] text-concrete">
          <span>
            {semantic === 'ready'
              ? 'Semantic placement on: it lands near what it means.'
              : semantic === 'off'
                ? 'Semantic index off (Settings → Semantic engine): placement by tag.'
                : `Semantic index ${semantic.replace('-', ' ')}…`}
          </span>
          <button type="button" className={BTN_PRIMARY} disabled={!text.trim() || busy || !writer} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add ↵'}
          </button>
        </div>
        {error && <p className="m-0 text-[12px] text-signal">{error}</p>}
        {hits.length > 0 && (
          <div>
            <p className="hud-label m-0 mb-1">Already in the world</p>
            <ul className="m-0 flex list-none flex-col p-0">
              {hits.map((h) => (
                <li key={h.node.id}>
                  <button
                    type="button"
                    className={`${BTN} flex w-full items-baseline justify-between gap-3 text-left normal-case`}
                    onClick={() => {
                      close()
                      selectAndFly(h.node.id)
                    }}
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-concrete uppercase">{h.node.archetype}</span> {h.node.title}
                    </span>
                    <span className="shrink-0 text-concrete">{h.why === 'meaning' ? `≈ ${Math.round(h.score * 100)}%` : 'title'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </HudDialog>
  )
}

/** Refinement status after the panel closes (bottom-left, transient). */
function OmniboxStatus() {
  const { stage, spawnMs, message, nodeId } = useOmnibox()
  const title = useWorld((s) => (nodeId ? s.nodes.get(nodeId)?.title : undefined))
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    setHidden(false)
    if (stage === 'refined') {
      const t = setTimeout(() => setHidden(true), 6000)
      return () => clearTimeout(t)
    }
  }, [stage, nodeId])
  if (stage === 'idle' || stage === 'spawning' || hidden) return null
  const tone = stage === 'refined' ? 'text-bone' : stage === 'refining' ? 'text-brass' : 'text-ember'
  return (
    <div role="status" className="hud-panel pointer-events-auto fixed bottom-24 left-3 z-30 flex max-w-sm flex-col gap-1 px-3 py-2 text-[11px]">
      <span className={tone}>
        {stage === 'refining' && `Claude is refining “${title ?? '…'}”…`}
        {stage === 'refined' && `Refined: ${title ?? ''}`}
        {(stage === 'fallback' || stage === 'error') && (message ?? 'Kept as typed.')}
      </span>
      {spawnMs !== null && (
        <span className="text-concrete">
          spawned in {spawnMs} ms{spawnMs > SPAWN_BUDGET_MS ? ` (over the ${SPAWN_BUDGET_MS} ms budget)` : ''}
        </span>
      )}
      {stage !== 'refining' && (
        <button type="button" className={`${BTN} self-start`} onClick={() => setHidden(true)}>
          Dismiss
        </button>
      )}
    </div>
  )
}

export function Omnibox() {
  const open = useApp((s) => s.panels.omnibox)
  return (
    <>
      {open && <OmniboxPanel />}
      <OmniboxStatus />
    </>
  )
}
