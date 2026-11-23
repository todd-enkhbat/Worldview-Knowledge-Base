import { describe, expect, it } from 'vitest'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { queryAgents, sampleAgentRoute } from '../../src/world/agents/model.ts'
import type { NodeRecord } from '../../src/domain/types.ts'

const T0 = Date.UTC(2000, 0, 1)
const record = (id: string, patch: Partial<NodeRecord> = {}) => makeNodeDraft(patch.archetype ?? 'idea', { id, title: id, temporalOrigin: T0, ...patch })

describe('query agent model', () => {
  it('uses actual keyword matches and respects radius, deletion, and inactive status', () => {
    const scout = record('scout', { archetype: 'demon', demon: { query: 'ocean', radius: 30, active: true } })
    const nodes = [scout, record('ocean-near'), record('ocean-far'), record('unrelated'), record('ocean-deleted', { deletedAt: T0 }), record('ocean-future')]
    const poses = { index: new Map([['scout', 0], ['ocean-near', 1], ['ocean-far', 2], ['unrelated', 3], ['ocean-future', 4]]), pos: new Float32Array([0, 0, 0, 10, 0, 0, 100, 0, 0, 5, 0, 0, 3, 0, 0]), born: new Uint8Array([1, 1, 1, 1, 0]) }
    const [agent] = queryAgents(nodes, { T0, yPerYear: 12 }, poses)
    expect(agent.active).toBe(true)
    expect(agent.route).toEqual(['ocean-near'])
    expect(agent.match.candidates).toBe(2)
    const [paused] = queryAgents([{ ...scout, demon: { ...scout.demon!, active: false } }, ...nodes.slice(1)], { T0, yPerYear: 12 }, poses)
    expect(paused.active).toBe(false)
    expect(paused.match.hits.map((hit) => hit.id)).toEqual(['ocean-near'])
  })

  it('never creates a saved agent or a match for an empty world or query', () => {
    expect(queryAgents([], { T0, yPerYear: 12 })).toEqual([])
    const [agent] = queryAgents([record('empty', { archetype: 'demon', demon: { query: ' ', radius: 100, active: true } }), record('thought')], { T0, yPerYear: 12 })
    expect(agent.active).toBe(false)
    expect(agent.route).toEqual([])
  })
})

describe('agent routes', () => {
  const poses = { index: new Map([['a', 0], ['b', 1], ['future', 2]]), pos: new Float32Array([0, 0, 0, 90, 10, 0, 900, 0, 0]), born: new Uint8Array([1, 1, 0]) }
  const home = { x: -5, y: 12, z: -5 }

  it('travels between real visible records and excludes unborn or missing IDs', () => {
    const point = { x: 0, y: 0, z: 0 }
    expect(sampleAgentRoute(['a', 'missing', 'b', 'future'], poses, 4.5, home, point)).toBe(2)
    expect(point.x).toBeCloseTo(45)
    expect(point.y).toBeCloseTo(18)
    expect(point.z).toBe(0)
    sampleAgentRoute(['a', 'b'], poses, 9, home, point)
    expect(point).toEqual({ x: 90, y: 18, z: 0 })
  })

  it('stays at its explicit UI home when no actual route is available', () => {
    const point = { x: 0, y: 0, z: 0 }
    expect(sampleAgentRoute(['missing', 'future'], poses, 100, home, point)).toBe(0)
    expect(point).toEqual(home)
  })
})
