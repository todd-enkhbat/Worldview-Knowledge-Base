import { describe, expect, it } from 'vitest'
import { computeSpatialWorld, SPATIAL_LAYOUT_VERSION } from '../../src/domain/spatial.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { mirrorAll, diffRecords, settingsKey } from '../../src/world/time/records.ts'
import { buildStaticPoseTable } from '../../src/world/nodes/staticPoses.ts'
import { dustEntries } from '../../src/world/dust/owners.ts'
import { UNIT } from '../../src/physics/fixed.ts'
import { anchorOfFor } from '../../src/overlay/fields.ts'
import { resetField, updateField } from '../../src/world/field/runtime.ts'

const T0 = Date.UTC(1990, 0, 1)
const settings = { T0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42 } as WorldSettings
const a = makeNodeDraft('memory', { id: 'a', title: 'Physics reading', tags: ['physics'], temporalOrigin: T0 + 5 * MS_PER_YEAR })
const b = makeNodeDraft('idea', { id: 'b', title: 'Related thought', tags: [], links: [{ targetId: 'a', kind: 'supports', createdAt: 1 }], temporalOrigin: T0 + 30 * MS_PER_YEAR })
const nodes = new Map([[a.id, a], [b.id, b]])

describe('one spatial anchor for simulation, fallback and GPU dust', () => {
  it('uses exactly the same world positions while dates only determine births', () => {
    const world = computeSpatialWorld(nodes.values())
    const mapped = mirrorAll(nodes, settings)
    const fallback = buildStaticPoseTable(nodes, settings, { index: new Map() })
    const dust = dustEntries(nodes, settings)
    const queryAnchor = anchorOfFor(settings, nodes.values())
    resetField()
    const rendered = updateField(nodes, settings, T0 + 40 * MS_PER_YEAR, 0)
    for (const record of mapped.records) {
      const anchor = world.positions.get(record.id)!
      expect(record.anchor).toEqual(anchor)
      const row = fallback.index.get(record.id)!
      expect(Array.from(fallback.pos.subarray(row * 3, row * 3 + 3))).toEqual(anchor.map(Math.fround))
      expect(dust.get(record.id)!.owner.anchor).toEqual(anchor.map((v) => Math.round(v * UNIT)))
      expect(queryAnchor(nodes.get(record.id)!)).toEqual(anchor)
      const renderRow = rendered.index.get(record.id)!
      expect(Array.from(rendered.centers.subarray(renderRow * 3, renderRow * 3 + 3))).toEqual(anchor.map(Math.fround))
    }
    const movedDate = new Map(nodes)
    movedDate.set('a', { ...a, temporalOrigin: a.temporalOrigin + 10 * MS_PER_YEAR, updatedAt: a.updatedAt + 1 })
    const changed = diffRecords(mapped.mirror, movedDate, settings)
    expect(changed.diff.upserts.find((r) => r.id === 'a')!.anchor).toEqual(world.positions.get('a'))
    expect(changed.diff.upserts.find((r) => r.id === 'a')!.birthStep).toBe(15 * 600)
    expect(settingsKey(settings).startsWith(SPATIAL_LAYOUT_VERSION)).toBe(true)
    expect(settingsKey(settings)).not.toMatch(/^semantic-volume-v1\|/)
    const differentCalendar = mirrorAll(nodes, { ...settings, T0: T0 - 50 * MS_PER_YEAR, yPerYear: 100 })
    expect(differentCalendar.records.map((r) => r.anchor)).toEqual(mapped.records.map((r) => r.anchor))
    resetField()
  })

  it('updates affected neighbor anchors even when their own updatedAt is unchanged', () => {
    const before = mirrorAll(nodes, settings)
    const changed = new Map(nodes)
    changed.set('a', { ...a, tags: ['art'], updatedAt: a.updatedAt + 1 })
    const diff = diffRecords(before.mirror, changed, settings)
    expect(diff.diff.upserts.map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(diff.mirror.get('b')!.updatedAt).toBe(b.updatedAt)
    const nextWorld = computeSpatialWorld(changed.values())
    expect(diff.diff.upserts.find((r) => r.id === 'b')!.anchor).toEqual(nextWorld.positions.get('b'))
  })
})
