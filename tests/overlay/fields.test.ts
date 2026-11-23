import { describe, expect, it } from 'vitest'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { anchorOfFor } from '../../src/overlay/fields.ts'

const settings = { T0: Date.UTC(2000, 0, 1), yPerYear: 12 }

describe('query spatial coordinates', () => {
  it('uses the same world-context semantic anchors as simulation before poses exist', () => {
    const a = makeNodeDraft('idea', { id: 'a', tags: ['physics'] })
    const b = makeNodeDraft('idea', { id: 'b', links: [{ targetId: 'a', kind: 'relates', createdAt: 1 }] })
    const records = [a, b]
    const world = computeSpatialWorld(records)
    const anchor = anchorOfFor(settings, records)
    expect(anchor(a)).toEqual(world.positions.get(a.id))
    expect(anchor(b)).toEqual(world.positions.get(b.id))
    expect(anchor(b)).not.toEqual(computeSpatialWorld([b]).positions.get(b.id))
  })

  it('matches at actual born physics poses rather than legacy date-height coordinates', () => {
    const node = makeNodeDraft('idea', { id: 'a', tags: ['physics'], temporalOrigin: settings.T0 + 1000 })
    const poses = { index: new Map([['a', 0]]), pos: new Float32Array([123, 77, -92]), born: new Uint8Array([1]) }
    const anchor = anchorOfFor(settings, [node], poses)
    expect(anchor(node)).toEqual([123, 77, -92])
    poses.born[0] = 0
    expect(anchor(node)).toEqual(computeSpatialWorld([node]).positions.get(node.id))
  })
})
