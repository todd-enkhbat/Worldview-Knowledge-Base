import { create } from 'zustand'
import { registerDevApi } from '../app/devApi.ts'
import { useApp, useWorld } from '../app/store.ts'
import { createNode, link, retypeNode, updateNode } from '../data/repo.ts'
import { truncateToPrecision } from '../domain/time.ts'
import type { NodeRecord, Provenance, TemporalPrecision } from '../domain/types.ts'
import { flyTo } from '../world/camera/flyTo.ts'
import { nodeText } from './embedText.ts'
import { semanticAnchorHint } from './layout.ts'
import { parseProvisional } from './provisional.ts'
import type { RefineInput, RefineOutput, RefineResult } from './refineSchema.ts'
import { embedTexts, isSemanticReady, nearest, type Neighbour } from './semanticIndex.ts'

// The omnibox (PLAN Phase 4): type a line, and
//   1. a provisional node spawns at once (heuristics; semantic placement when the index is
//      warm and answers within SEMANTIC_BUDGET_MS), well under the 1500 ms budget;
//   2. Claude Haiku 5.5 refines it server-side (archetype, title, body, tags, dates, mass,
//      links to semantic neighbours). A refusal or failure keeps the provisional record,
//      marked 'fallback'. The refinement is one undoable step.

export const SPAWN_BUDGET_MS = 1500
const SEMANTIC_BUDGET_MS = 700
const CANDIDATES = 12

export type OmniboxStage = 'idle' | 'spawning' | 'refining' | 'refined' | 'fallback' | 'error'

export interface OmniboxState {
  stage: OmniboxStage
  nodeId: string | null
  spawnMs: number | null
  message: string | null
}

export const useOmnibox = create<OmniboxState>()(() => ({ stage: 'idle', nodeId: null, spawnMs: null, message: null }))

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

/** Semantic neighbours of the raw text, if the index answers in time. */
async function neighboursOf(draftText: string): Promise<Neighbour[] | null> {
  if (!isSemanticReady()) return null
  return withTimeout(
    embedTexts([draftText]).then(([v]) => nearest(v, CANDIDATES)),
    SEMANTIC_BUDGET_MS,
  ).catch(() => null)
}

/** Recently touched live nodes: link candidates when there is no semantic index. */
function recentCandidates(exclude: string): NodeRecord[] {
  return [...useWorld.getState().nodes.values()]
    .filter((n) => n.id !== exclude)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, CANDIDATES)
}

export async function submitOmnibox(raw: string, opts: { refine?: boolean; fetch?: typeof fetch } = {}): Promise<NodeRecord> {
  const settings = useWorld.getState().settings
  if (!settings) throw new Error('The world is not ready')
  const text = raw.trim()
  if (!text) throw new Error('Type something first')
  const t0 = performance.now()
  useOmnibox.setState({ stage: 'spawning', nodeId: null, spawnMs: null, message: null })

  const now = Date.now()
  const draft = parseProvisional(text, { now, T0: settings.T0 })
  const provenance: Provenance = { source: 'omnibox', state: 'provisional', raw: text }
  const neighbours = await neighboursOf(nodeText({ title: draft.title, tags: draft.tags, contentMd: draft.contentMd, archetype: draft.archetype }))
  const nodes = useWorld.getState().nodes
  const hint = neighbours
    ? semanticAnchorHint(
        neighbours.flatMap((n) => {
          const r = nodes.get(n.id)
          return r ? [{ anchorXZ: r.anchorXZ, similarity: n.similarity }] : []
        }),
        draft.archetype,
      )
    : null

  const record = await createNode(
    {
      archetype: draft.archetype,
      title: draft.title,
      contentMd: draft.contentMd,
      tags: draft.tags,
      temporalOrigin: draft.temporalOrigin,
      temporalPrecision: draft.temporalPrecision,
      provenance,
      ...(draft.entityKind ? { entity: { kind: draft.entityKind } } : {}),
      ...(draft.demonQuery !== undefined ? { demon: { query: draft.demonQuery, radius: 12, active: true } } : {}),
    },
    { anchorHint: hint ?? undefined },
  )
  const spawnMs = Math.round(performance.now() - t0)
  useOmnibox.setState({ stage: opts.refine === false ? 'fallback' : 'refining', nodeId: record.id, spawnMs })
  flyTo(record.id)
  if (opts.refine === false) return record

  void refine(record, text, neighbours, opts.fetch ?? ((...a) => fetch(...a)))
  return record
}

async function refine(record: NodeRecord, text: string, neighbours: Neighbour[] | null, f: typeof fetch): Promise<void> {
  const settings = useWorld.getState().settings!
  const nodes = useWorld.getState().nodes
  const candidates = (neighbours?.length ? neighbours.map((n) => nodes.get(n.id)).filter((n): n is NodeRecord => !!n) : recentCandidates(record.id))
    .filter((n) => n.id !== record.id)
    .slice(0, CANDIDATES)
    .map((n) => ({ id: n.id, title: n.title.slice(0, 200), archetype: n.archetype }))
  const input: RefineInput = { text, today: isoDay(Date.now()), t0: isoDay(settings.T0), candidates }

  let result: RefineResult
  try {
    const res = await f('/api/refine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (res.status === 404) result = { ok: false, reason: 'unavailable', message: 'Refinement needs the dev server (npm run dev).' }
    else if (res.status === 503) result = { ok: false, reason: 'unavailable', message: 'Add ANTHROPIC_API_KEY to .env.local and restart the dev server.' }
    else result = (await res.json()) as RefineResult
  } catch (e) {
    result = { ok: false, reason: 'unavailable', message: e instanceof Error ? e.message : String(e) }
  }

  // The user may have deleted or edited the node meanwhile: only touch it if it is still ours.
  const current = useWorld.getState().nodes.get(record.id)
  if (!current || current.provenance?.state !== 'provisional') return

  if (!result.ok) {
    await updateNode(record.id, { provenance: { ...current.provenance, state: 'fallback' } }, { keepAnchor: true }).catch(() => {})
    const why = result.reason === 'refusal' ? 'Claude declined to refine this; kept as typed.' : (result.message ?? `Refinement failed (${result.reason}); kept as typed.`)
    useOmnibox.setState({ stage: 'fallback', message: why })
    return
  }
  try {
    await applyRefinement(current, result.output)
    useOmnibox.setState({ stage: 'refined', message: null })
  } catch (e) {
    useOmnibox.setState({ stage: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

function parsePartialIso(iso: string, precision: TemporalPrecision): number {
  const [y, m, d] = iso.split('-').map(Number)
  const t = Date.UTC(y, (m || 1) - 1, d || 1)
  return truncateToPrecision(t, precision)
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

/** Apply Claude's version over the provisional record, as one undoable step. */
export async function applyRefinement(prev: NodeRecord, out: RefineOutput): Promise<NodeRecord> {
  const settings = useWorld.getState().settings!
  const now = Date.now()
  const snapshot = structuredClone(prev)
  if (out.archetype !== prev.archetype) await retypeNode(prev.id, out.archetype as NodeRecord['archetype'])

  const origin = clamp(parsePartialIso(out.date.iso, out.date.precision), settings.T0, now)
  const patch: Partial<NodeRecord> = {
    title: out.title,
    contentMd: out.contentMd,
    tags: [...new Set(out.tags.map((t) => t.toLowerCase().replace(/\s+/g, '-')))],
    temporalOrigin: Number.isFinite(origin) ? origin : prev.temporalOrigin,
    temporalPrecision: out.date.precision,
    referenceDate: out.referenceDate
      ? { epochMs: parsePartialIso(out.referenceDate.iso, out.referenceDate.precision), precision: out.referenceDate.precision, label: out.referenceDate.label || undefined }
      : null,
    thermo: { mass: clamp(out.mass, 0.25, 4), temperature: clamp(out.temperature, 0, 1) },
    provenance: { source: 'omnibox', state: 'refined', raw: prev.provenance?.raw ?? '', refinedAt: now },
  }
  if (patch.referenceDate && !Number.isFinite(patch.referenceDate.epochMs)) patch.referenceDate = null
  if (patch.referenceDate && patch.referenceDate.label === undefined) delete patch.referenceDate.label
  if (out.archetype === 'entity' && out.entityKind) patch.entity = { kind: out.entityKind }
  if (out.archetype === 'demon') patch.demon = { query: out.demonQuery ?? out.title, radius: 12, active: true }
  let next = await updateNode(prev.id, patch, { keepAnchor: true })
  for (const l of out.links) {
    if (!useWorld.getState().nodes.has(l.targetId) || l.targetId === prev.id) continue
    next = await link(prev.id, l.targetId, l.kind, l.label ?? undefined).catch(() => next)
  }
  useApp.getState().pushToast({
    message: `Refined by Claude: ${next.title}`,
    undo: () => void undoRefinement(snapshot),
  })
  return next
}

async function undoRefinement(snapshot: NodeRecord): Promise<void> {
  const cur = useWorld.getState().nodes.get(snapshot.id)
  if (!cur) return
  if (cur.archetype !== snapshot.archetype) await retypeNode(snapshot.id, snapshot.archetype)
  const { id: _id, archetype: _a, anchorXZ: _x, createdAt: _c, deletedAt: _d, schemaVersion: _s, attachments: _att, ...rest } = snapshot
  await updateNode(snapshot.id, { ...rest, provenance: { ...snapshot.provenance!, state: 'fallback' } }, { keepAnchor: true })
}

registerDevApi('omnibox', (text: string, opts?: { refine?: boolean }) => submitOmnibox(text, opts))
registerDevApi('omniboxState', () => useOmnibox.getState())
