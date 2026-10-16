import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, getStore, initRepo, logEvent, updateNode } from '../../src/data/repo.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import {
  PAID_KV,
  activateDemon,
  compactLog,
  foldLog,
  getOverlayFields,
  getPlasticity,
  kTEffNow,
  landauerCost,
  previewCompaction,
  refreshOverlays,
  resetOverlays,
  startOverlays,
  synapseKey,
  useOverlaySummary,
} from '../../src/overlay/index.ts'

const T0 = Date.UTC(1990, 0, 1)
const START = Date.UTC(2026, 5, 1)
let now = START
let store: WorldStore
let stop: (() => void) | null = null

beforeEach(async () => {
  now = START
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  resetOverlays()
  store = createMemoryStore()
  await initRepo({ store, now: () => now })
  await completeFirstRun({ T0, start: 'empty' })
})

afterEach(async () => {
  stop?.()
  stop = null
  await closeRepo()
})

const idea = (title: string) => createNode({ archetype: 'idea', title })

describe('overlay engine', () => {
  it('folds the log on start, then incrementally, agreeing with a full recompute', async () => {
    const a = await idea('Entropy')
    const b = await idea('Gibbs')
    await logEvent('inspect', a.id)
    stop = startOverlays()
    await refreshOverlays()
    expect(useOverlaySummary.getState()).toMatchObject({ loaded: true, events: 1 })

    now += 5 * 60_000
    await logEvent('dwell', b.id)
    now += 60_000
    await logEvent('enter', a.id)
    await refreshOverlays(false)
    const inc = getPlasticity()
    expect(inc.events).toBe(3)
    expect(inc.synapses.has(synapseKey(a.id, b.id))).toBe(true)
    const full = foldLog(await getStore().listEvents())
    expect([...inc.traces.entries()].sort()).toEqual([...full.traces.entries()].sort())
    expect([...inc.synapses.entries()].sort()).toEqual([...full.synapses.entries()].sort())
    expect(useOverlaySummary.getState().synapses).toBe(1)

    const f = getOverlayFields(now)
    expect(f.nodes.get(a.id)!.y).toBeGreaterThan(0)
    expect(f.nodes.get(a.id)!.citadel).toBeGreaterThan(0)
    expect(f.synapses).toHaveLength(1)
  })

  it('logs demon activations with log2(C/M) bits and pays the debt on compaction', async () => {
    await idea('Entropy')
    await idea('Gibbs free energy')
    await idea('Maxwell')
    await idea('Entropy and the arrow of time')
    const d = await createNode({ archetype: 'demon', title: 'Sorter', demon: { query: 'entropy', radius: 1000, active: true } })
    stop = startOverlays()
    await refreshOverlays()

    const res = await activateDemon(d.id, now)
    expect(res).not.toBeNull()
    expect(res!.match.candidates).toBe(4)
    expect(res!.match.hits).toHaveLength(2)
    expect(res!.match.bitsPerMatch).toBe(1)
    expect(res!.logged).toBe(2)
    await refreshOverlays(false)
    expect(useOverlaySummary.getState()).toMatchObject({ bits: 2, demonEvents: 2 })
    const f = getOverlayFields(now + 1)
    expect(f.plan.assignments.size).toBe(2)
    expect(f.activation.get(d.id)).toBe(now)

    const preview = await previewCompaction()
    expect(preview.bits).toBe(2)
    expect(preview.cost).toBeCloseTo(landauerCost(2, kTEffNow()), 12)
    await expect(compactLog({ confirm: false })).rejects.toThrow(/confirm/)
    const r = await compactLog({ confirm: true, now: now + 1 })
    expect(r.events).toBe(2)
    expect(r.paid).toMatchObject({ bits: 2, events: 2, compactions: 1 })
    expect(await store.getKv(PAID_KV)).toMatchObject({ bits: 2 })
    expect(await store.listEvents()).toHaveLength(0)
    expect(useOverlaySummary.getState()).toMatchObject({ bits: 0, events: 0, paid: { bits: 2 } })
    // The plan is a function of the records: still sorted, now settled (no activation logged).
    expect(getOverlayFields(now + 2).activation.get(d.id)).toBeNull()
  })

  it('treats a query edit of an active demon as an activation', async () => {
    await idea('Gibbs')
    await idea('Entropy')
    const d = await createNode({ archetype: 'demon', title: 'Sorter', demon: { query: 'entropy', radius: 1000, active: true } })
    stop = startOverlays()
    await refreshOverlays()
    expect(useOverlaySummary.getState().demonEvents).toBe(0)
    await updateNode(d.id, { demon: { query: 'gibbs', radius: 1000, active: true } })
    await vi.waitFor(async () => {
      await refreshOverlays(false)
      expect(useOverlaySummary.getState().demonEvents).toBe(1)
    }, 3000)
    expect(useOverlaySummary.getState().perDemon[d.id]).toMatchObject({ events: 1, bits: 1 })
  })
})
