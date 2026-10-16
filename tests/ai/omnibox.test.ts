import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo, reanchorNodes, retypeNode, updateNode } from '../../src/data/repo.ts'
import { minRadiusFor } from '../../src/domain/placement.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { SPAWN_BUDGET_MS, submitOmnibox, useOmnibox } from '../../src/ai/omnibox.ts'
import type { RefineInput, RefineOutput, RefineResult } from '../../src/ai/refineSchema.ts'

const T0 = Date.UTC(1990, 4, 17)

beforeEach(async () => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0, start: 'empty' })
})

afterEach(async () => {
  await closeRepo()
})

const live = (id: string) => useWorld.getState().nodes.get(id)!
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(cond()).toBe(true)
}

describe('repo: Phase 4 operations', () => {
  it('createNode honours an anchor hint (nudged to a free spot near it)', async () => {
    const n = await createNode({ archetype: 'idea', title: 'Hinted' }, { anchorHint: [0, 33] })
    expect(Math.hypot(n.anchorXZ[0] - 0, n.anchorXZ[1] - 33)).toBeLessThan(1)
  })

  it('retypeNode resets per-archetype blocks and keeps the memory clear of the axis', async () => {
    const n = await createNode({ archetype: 'entity', title: 'Something', entity: { kind: 'person' } }, { anchorHint: [0, 8] })
    expect(n.entity).toEqual({ kind: 'person' })
    const m = await retypeNode(n.id, 'memory')
    expect(m.archetype).toBe('memory')
    expect(m.entity).toBeUndefined()
    expect(Math.hypot(...m.anchorXZ)).toBeGreaterThanOrEqual(minRadiusFor('memory'))
    const d = await retypeNode(n.id, 'demon')
    expect(d.demon).toMatchObject({ query: 'Something', active: true })
  })

  it('updateNode keepAnchor survives a primary-tag change', async () => {
    const n = await createNode({ archetype: 'idea', title: 'Keep me', tags: ['a'] }, { anchorHint: [0, 33] })
    const kept = await updateNode(n.id, { tags: ['zzz'] }, { keepAnchor: true })
    expect(kept.anchorXZ).toEqual(n.anchorXZ)
    const moved = await updateNode(n.id, { tags: ['qqq'] })
    expect(moved.anchorXZ).not.toEqual(n.anchorXZ)
  })

  it('reanchorNodes moves many anchors atomically and the toast undoes all of them', async () => {
    const a = await createNode({ archetype: 'idea', title: 'A' })
    const b = await createNode({ archetype: 'idea', title: 'B' })
    const moved = await reanchorNodes(new Map([[a.id, [0, 40] as [number, number]], [b.id, [0, -40] as [number, number]]]), 'Test')
    expect(moved).toHaveLength(2)
    expect(live(a.id).anchorXZ[1]).toBeCloseTo(40, 0)
    useApp.getState().toasts.at(-1)!.undo!()
    await until(() => live(a.id).anchorXZ[0] === a.anchorXZ[0] && live(b.id).anchorXZ[0] === b.anchorXZ[0])
  })
})

describe('omnibox', () => {
  const refined: RefineOutput = {
    archetype: 'document',
    title: 'A Mathematical Theory of Communication',
    contentMd: 'Shannon (1948).',
    tags: ['information theory'],
    date: { iso: '2019', precision: 'year' },
    referenceDate: { iso: '1948', precision: 'year', label: 'Published' },
    entityKind: null,
    demonQuery: null,
    mass: 9, // out of range: clamped
    temperature: 0.2,
    links: [],
  }

  function refineFetch(result: RefineResult, seen: RefineInput[] = []): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)) as RefineInput)
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }

  it('spawns a provisional node within budget, then applies the refinement as one undoable step', async () => {
    const other = await createNode({ archetype: 'entity', title: 'Claude Shannon', entity: { kind: 'person' } })
    const seen: RefineInput[] = []
    const ok: RefineResult = { ok: true, model: 'claude-haiku-5-5', output: { ...refined, links: [{ targetId: other.id, kind: 'derives', label: null }] } }
    const rec = await submitOmnibox('read shannon info theory paper in 2019 #information', { fetch: refineFetch(ok, seen) })
    expect(rec.archetype).toBe('document')
    expect(rec.provenance).toMatchObject({ source: 'omnibox', state: 'provisional' })
    expect(rec.tags).toEqual(['information'])
    expect(useOmnibox.getState().spawnMs!).toBeLessThan(SPAWN_BUDGET_MS)

    await until(() => live(rec.id).provenance?.state === 'refined')
    const r: NodeRecord = live(rec.id)
    expect(r.title).toBe(refined.title)
    expect(r.tags).toEqual(['information-theory'])
    expect(r.thermo.mass).toBe(4)
    expect(r.temporalOrigin).toBe(Date.UTC(2019, 0, 1))
    expect(r.referenceDate).toMatchObject({ epochMs: Date.UTC(1948, 0, 1), label: 'Published' })
    expect(r.links.map((l) => l.targetId)).toEqual([other.id])
    expect(r.anchorXZ).toEqual(rec.anchorXZ) // refinement never re-places
    expect(seen[0].candidates.map((c) => c.id)).toContain(other.id)
    expect(useOmnibox.getState().stage).toBe('refined')

    useApp.getState().toasts.at(-1)!.undo!()
    await until(() => live(rec.id).title === rec.title)
    expect(live(rec.id).links).toEqual([])
  })

  it('keeps the provisional record (marked fallback) on a refusal', async () => {
    const rec = await submitOmnibox('Free will is an illusion', { fetch: refineFetch({ ok: false, reason: 'refusal' }) })
    await until(() => live(rec.id).provenance?.state === 'fallback')
    expect(live(rec.id).title).toBe('Free will is an illusion')
    expect(useOmnibox.getState()).toMatchObject({ stage: 'fallback' })
    expect(useOmnibox.getState().message).toMatch(/declined/)
  })

  it('re-types the node when Claude reclassifies it', async () => {
    const rec = await submitOmnibox('Ada Lovelace', { fetch: refineFetch({ ok: true, model: 'm', output: { ...refined, archetype: 'idea', title: 'Poetical science' } }) })
    expect(rec.archetype).toBe('entity')
    await until(() => live(rec.id).provenance?.state === 'refined')
    expect(live(rec.id).archetype).toBe('idea')
    expect(live(rec.id).entity).toBeUndefined()
  })
})
