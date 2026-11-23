import { beforeEach, describe, expect, it } from 'vitest'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import type { NodeRecord, WorldSettings } from '../../src/domain/types.ts'
import { getPoseTable, setPoseTable, type PoseTable } from '../../src/world/poses.ts'
import { fieldPinOffsets, getFieldFrame, previewFieldAnchor, resetField, updateField } from '../../src/world/field/runtime.ts'

const T = Date.UTC(2015, 0, 1)
const settings = { T0: T, yPerYear: 12, stepsPerYear: 600 } as WorldSettings
const rec = (id: string, years: number, anchor: [number, number], links: string[] = []): NodeRecord =>
  ({ id, temporalOrigin: T + years * MS_PER_YEAR, anchorXZ: anchor, tags: [], links: links.map((targetId) => ({ targetId, kind: 'supports', createdAt: 0 })), thermo: { mass: 1, temperature: 0.3 }, deletedAt: null }) as unknown as NodeRecord

const row = (id: string) => getFieldFrame().index.get(id)!
const center = (id: string) => Array.from(getFieldFrame().centers.subarray(row(id) * 3, row(id) * 3 + 3))

describe('canonical field adapter', () => {
  beforeEach(() => resetField())

  it('uses semantic XYZ while the history playhead only changes future/active flags', () => {
    const nodes = new Map([rec('a', 0, [20, 0]), rec('b', 1, [20, 0]), rec('future', 9, [30, 0])].map((r) => [r.id, r]))
    const spatial = computeSpatialWorld(nodes.values())
    updateField(nodes, settings, T + 5 * MS_PER_YEAR, 0)
    for (const id of nodes.keys()) expect(center(id)).toEqual(spatial.positions.get(id)!.map(Math.fround))
    const futurePosition = center('future')
    expect(getFieldFrame().born[row('future')]).toBe(0)
    updateField(nodes, settings, T + 10 * MS_PER_YEAR, 1)
    expect(getFieldFrame().born[row('future')]).toBe(1)
    expect(center('future')).toEqual(futurePosition)
  })

  it('reads actual physics/overlay poses by id without overwriting the shared canonical table', () => {
    const nodes = new Map([rec('a', 1, [20, 0]), rec('b', 2, [40, 0])].map((r) => [r.id, r]))
    const source: PoseTable = { version: 15, index: new Map([['b', 0], ['a', 1]]), pos: new Float32Array([43.5, 24.375, 7, 22.25, 12.125, -1.5]), born: new Uint8Array([1, 1]) }
    setPoseTable(source)
    const originalPoses = getPoseTable()
    updateField(nodes, settings, T + 3 * MS_PER_YEAR, 0, source)
    expect(center('a')).toEqual([22.25, 12.125, -1.5])
    expect(center('b')).toEqual([43.5, 24.375, 7])
    expect(getPoseTable()).toBe(originalPoses)
    source.pos[4] = 12.25
    source.version++
    updateField(nodes, settings, T + 3 * MS_PER_YEAR, 1, source)
    expect(center('a')[1]).toBe(12.25)
    expect(getPoseTable().pos).toBe(source.pos)
  })

  it('restores the same spatial fallback on a scrub and handles missing settings like static anchors', () => {
    const nodes = new Map([rec('a', 0, [20, 0]), rec('b', 2, [-20, 0])].map((r) => [r.id, r]))
    updateField(nodes, null, T + 3 * MS_PER_YEAR, 0)
    const first = Float32Array.from(getFieldFrame().centers)
    updateField(nodes, null, T + 7 * MS_PER_YEAR, 1)
    updateField(nodes, null, T + 3 * MS_PER_YEAR, 2)
    expect(getFieldFrame().centers).toEqual(first)
    expect(center('b')[1]).toBe(Math.fround(computeSpatialWorld(nodes.values()).positions.get('b')![1]))
  })

  it('pins only XZ, preserves semantic altitude, and cancels only the transient drag offset', () => {
    const a = { ...rec('a', 2, [20, 0]), fieldAnchorXZ: [30, 5] as [number, number] }
    const nodes = new Map([[a.id, a]])
    const altitude = Math.fround(computeSpatialWorld(nodes.values()).positions.get('a')![1])
    updateField(nodes, settings, T + 3 * MS_PER_YEAR, 0)
    expect(center('a')).toEqual([30, altitude, 5])
    expect(fieldPinOffsets(nodes).size).toBe(0)
    previewFieldAnchor(a.id, [35, 10])
    updateField(nodes, settings, T + 3 * MS_PER_YEAR, 1)
    expect(center('a')).toEqual([35, altitude, 10])
    expect(fieldPinOffsets(nodes).get('a')).toEqual([5, 5])
    previewFieldAnchor(a.id, null)
    updateField(nodes, settings, T + 3 * MS_PER_YEAR, 2)
    expect(center('a')).toEqual([30, altitude, 5])
    expect(nodes.get('a')?.anchorXZ).toEqual([20, 0])
  })
})
