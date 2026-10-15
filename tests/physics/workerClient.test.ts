import { afterEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { MS_PER_YEAR, STEPS_PER_YEAR, Y_PER_YEAR } from '../../src/domain/constants.ts'
import type { NodeRecord, WorldSettings } from '../../src/domain/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { PhysicsHost } from '../../src/physics/workerHost.ts'
import type { FromWorker, ToWorker } from '../../src/physics/workerProtocol.ts'
import { buildWorld, readPoses, runTo, stateHashById } from '../../src/physics/world.ts'
import { getPoseTable } from '../../src/world/poses.ts'
import { getPlayhead } from '../../src/world/time/clock.ts'
import { PhysicsClient, type WorkerLike, useSimStats } from '../../src/world/time/physicsClient.ts'
import { PoseWriter } from '../../src/world/time/poseWriter.ts'
import { diffRecords, mirrorAll, toWorldRecord } from '../../src/world/time/records.ts'

// The main-thread client against an in-process PhysicsHost behind a fake Worker: the
// record mapping, the load/edit diff, frames into the pose table, and the fallback.

const NOW = Date.now()
const T0 = NOW - 3 * MS_PER_YEAR
const settings: WorldSettings = {
  T0,
  yPerYear: Y_PER_YEAR,
  stepsPerYear: STEPS_PER_YEAR,
  physicsSeed: 0x5eed,
  qualityTier: 'auto',
  firstRunComplete: true,
  lastBackupAt: null,
  autoBackupEnabled: false,
  createdAt: T0,
  schemaVersion: 1,
}

function nodes(n: number): NodeRecord[] {
  const out: NodeRecord[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    out.push(
      makeNodeDraft(i % 2 ? 'idea' : 'memory', {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        title: `n${i}`,
        temporalOrigin: T0 + ((i + 0.5) / n) * 2.9 * MS_PER_YEAR,
        anchorXZ: [Math.round(20 * Math.cos(a) * 100) / 100, Math.round(20 * Math.sin(a) * 100) / 100],
        thermo: { mass: 0.5 + (i % 4) * 0.5, temperature: (i % 5) / 4 },
        updatedAt: 1000,
      }),
    )
  }
  return out
}

function fakeWorker() {
  const sent: ToWorker[] = []
  const queue: (() => void)[] = []
  let terminated = false
  const fw: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m: ToWorker) {
      sent.push(m)
      host.handle(structuredClone(m))
    },
    terminate() {
      terminated = true
    },
  }
  const host: PhysicsHost = new PhysicsHost({
    post: (m: FromWorker) => fw.onmessage?.({ data: m } as MessageEvent<FromWorker>),
    schedule: (fn) => queue.push(fn),
    delay: () => undefined,
    now: () => 0,
    tickBudgetMs: 0,
    seekChunk: 256,
  })
  const drain = () => {
    while (queue.length) queue.shift()!()
  }
  return { fw, host, sent, drain, isTerminated: () => terminated }
}

afterEach(() => {
  useWorld.getState().hydrate(null, [])
  useApp.getState().setClock({ settling: false })
})

describe('record mapping', () => {
  it('maps a NodeRecord to its physics view (Y is time)', () => {
    const n = makeNodeDraft('memory', {
      id: 'x',
      temporalOrigin: T0 + 2.5 * MS_PER_YEAR,
      anchorXZ: [4, -7],
      thermo: { mass: 9, temperature: -1 }, // out of range: clamped, never trips the gate
    })
    expect(toWorldRecord(n, settings)).toEqual({
      id: 'x',
      anchor: [4, 30, -7],
      birthStep: 1500,
      mass: 4,
      temperature: 0,
    })
    expect(toWorldRecord({ ...n, deletedAt: NOW }, settings)).toBeNull()
    expect(toWorldRecord({ ...n, anchorXZ: [Number.NaN, 0] }, settings)).toBeNull()
    // Before T0: born at step 0, anchored below the origin.
    const early = toWorldRecord({ ...n, temporalOrigin: T0 - MS_PER_YEAR }, settings)!
    expect(early.birthStep).toBe(0)
    expect(early.anchor[1]).toBe(-12)
  })

  it('diffs by updatedAt: physics-neutral edits only refresh the mirror', () => {
    const list = nodes(4)
    const map = new Map(list.map((n) => [n.id, n]))
    const { mirror } = mirrorAll(map, settings)
    const next = new Map(map)
    next.set(list[0].id, { ...list[0], title: 'renamed', updatedAt: 2000 }) // no physics change
    next.set(list[1].id, { ...list[1], anchorXZ: [1, 2], updatedAt: 2000 })
    next.delete(list[2].id)
    const extra = makeNodeDraft('idea', { id: 'new', temporalOrigin: T0 + MS_PER_YEAR, anchorXZ: [9, 9] })
    next.set('new', extra)
    const { mirror: m2, diff } = diffRecords(mirror, next, settings)
    expect(diff.upserts.map((r) => r.id)).toEqual([list[1].id, 'new'])
    expect(diff.removes).toEqual([list[2].id])
    expect(m2.get(list[0].id)!.updatedAt).toBe(2000)
    expect(diffRecords(m2, next, settings).diff).toEqual({ upserts: [], removes: [] })
  })
})

describe('physics client', () => {
  it('loads, renders frames into the pose table and mirrors edits', () => {
    const list = nodes(24)
    useWorld.getState().hydrate(settings, list)
    const fake = fakeWorker()
    const client = new PhysicsClient(() => fake.fw)
    expect(client.start()).toBe(true)

    // The load carries the mapped records and starts at the present.
    const load = fake.sent[0]
    expect(load.type).toBe('load')
    if (load.type !== 'load') return
    expect(load.records).toHaveLength(24)
    expect(load.target).toBe(getPlayhead().step)
    expect(load.target).toBe(Math.round(3 * STEPS_PER_YEAR))
    expect(useApp.getState().clock.step).toBe(load.target)
    fake.drain()

    const frame = client.acquire()!
    expect(frame.step).toBe(load.target)
    expect(useSimStats.getState().mode).toBe('physics')
    expect(useApp.getState().clock.settling).toBe(false)

    const ref = buildWorld({ records: load.records, seed: settings.physicsSeed })
    runTo(ref, load.target)
    const refPos = new Float32Array(3 * ref.sys.count)
    readPoses(ref, refPos)
    const writer = new PoseWriter()
    const table = writer.writePhysics(frame, load.target, 0)
    expect(getPoseTable()).toBe(table)
    expect(table.index.size).toBe(24)
    for (const n of list) {
      const row = table.index.get(n.id)!
      const s = ref.slotOf.get(n.id)!
      expect([...table.pos.subarray(3 * row, 3 * row + 3)]).toEqual([...refPos.subarray(3 * s, 3 * s + 3)])
      expect(table.born[row]).toBe(1)
    }

    // Half a step on: X + ½·D. A step in the past: the newest node is a ghost on its anchor.
    const v0 = table.version
    writer.writePhysics(frame, load.target, 0.5)
    expect(getPoseTable().version).toBe(v0 + 1)
    const id0 = list[0].id
    const r0 = table.index.get(id0)!
    expect(table.pos[3 * r0]).toBeCloseTo(refPos[3 * ref.slotOf.get(id0)!] + 0.5 * frame.vel[3 * r0], 4)
    const newest = list.at(-1)!
    const rn = table.index.get(newest.id)!
    const nb = frame.slots.birth[rn]
    writer.writePhysics(frame, nb - 1, 0)
    expect(table.born[rn]).toBe(0)
    expect(table.pos[3 * rn + 1]).toBe(frame.slots.anchor[3 * rn + 1])
    // Unchanged input: no version bump (readers skip the frame).
    const v1 = getPoseTable().version
    writer.writePhysics(frame, nb - 1, 0)
    expect(getPoseTable().version).toBe(v1)

    // Edits flow through useWorld → diff → edit message → recompute.
    const moved = { ...list[3], thermo: { mass: 2, temperature: 0.9 }, updatedAt: 5000 }
    useWorld.getState().upsertLocal(moved)
    useWorld.getState().removeLocal(list[5].id)
    const edits = fake.sent.filter((m) => m.type === 'edit')
    expect(edits).toHaveLength(2)
    expect(edits[0]).toMatchObject({ type: 'edit', upserts: [{ id: list[3].id, mass: 2, temperature: 0.9 }], removes: [] })
    expect(edits[1]).toMatchObject({ type: 'edit', upserts: [], removes: [list[5].id] })
    expect(useApp.getState().clock.settling).toBe(true)
    fake.drain()
    expect(useApp.getState().clock.settling).toBe(false)
    const after = client.acquire()!
    expect(after.slots.ids).not.toContain(list[5].id)
    const finalRecords = [...useWorld.getState().nodes.values()].map((n) => toWorldRecord(n, settings)!)
    const ref2 = buildWorld({ records: finalRecords, seed: settings.physicsSeed })
    runTo(ref2, load.target)
    expect(stateHashById(fake.host.current!)).toBe(stateHashById(ref2))

    // Targets go out only when the step changes.
    const n0 = fake.sent.length
    client.sendTarget(load.target + 1)
    client.sendTarget(load.target + 1)
    expect(fake.sent.length).toBe(n0 + 1)

    client.stop()
    expect(fake.isTerminated()).toBe(true)
  })

  it('falls back to static anchors when the worker fails', () => {
    useWorld.getState().hydrate(settings, nodes(6))
    const fake = fakeWorker()
    const client = new PhysicsClient(() => fake.fw)
    client.start()
    fake.fw.onmessage?.({ data: { type: 'error', gen: 1, message: 'boom', fatal: true } } as MessageEvent<FromWorker>)
    expect(client.failed).toBe(true)
    expect(client.acquire()).toBeNull()
    expect(useSimStats.getState()).toMatchObject({ mode: 'static', error: 'boom' })
    expect(fake.isTerminated()).toBe(true)

    const broken = new PhysicsClient(() => {
      throw new Error('no workers here')
    })
    expect(broken.start()).toBe(false)
    expect(broken.failed).toBe(true)
  })

  it('static fallback marks records born after the playhead as ghosts', () => {
    const list = nodes(6)
    const map = new Map(list.map((n) => [n.id, n]))
    const writer = new PoseWriter()
    const t = writer.writeStatic(map, settings, 1, 900)
    const born = list.map((n) => t.born[t.index.get(n.id)!])
    const expected = list.map((n) => (Math.round(((n.temporalOrigin - T0) / MS_PER_YEAR) * STEPS_PER_YEAR) <= 900 ? 1 : 0))
    expect(born).toEqual(expected)
    expect(born).toContain(0)
    expect(born).toContain(1)
    const v = getPoseTable().version
    writer.writeStatic(map, settings, 1, 900)
    expect(getPoseTable().version).toBe(v) // nothing changed
    writer.writeStatic(map, null, 2, 0)
    expect([...getPoseTable().born]).toEqual(list.map(() => 1)) // no T0 yet: all born
  })
})
