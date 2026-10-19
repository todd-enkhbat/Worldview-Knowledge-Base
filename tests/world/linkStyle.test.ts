import { describe, expect, it } from 'vitest'
import type { LinkKind, NodeRecord } from '../../src/domain/types.ts'
import { buildTypedLinks, distToSegment2, linkSentence } from '../../src/world/links/style.ts'

function rec(id: string, links: [string, LinkKind][] = []): NodeRecord {
  return { id, title: id.toUpperCase(), links: links.map(([targetId, kind]) => ({ targetId, kind, createdAt: 0 })) } as unknown as NodeRecord
}
const world = (...rs: NodeRecord[]) => new Map(rs.map((r) => [r.id, r]))

describe('buildTypedLinks', () => {
  it('keeps one link per pair, the most assertive kind', () => {
    const out = buildTypedLinks(world(rec('a', [['b', 'relates']]), rec('b', [['a', 'contradicts']])))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('contradicts')
  })

  it('points directed kinds from the source idea to the node that declares them', () => {
    const [l] = buildTypedLinks(world(rec('a', [['b', 'derives']]), rec('b')))
    expect([l.from, l.to]).toEqual(['b', 'a'])
    expect(linkSentence(l, (id) => id.toUpperCase())).toBe('A — derives from → B')
  })

  it('drops self links and dangling targets', () => {
    expect(buildTypedLinks(world(rec('a', [['a', 'supports'], ['zz', 'supports']])))).toEqual([])
  })
})

describe('distToSegment2', () => {
  it('measures to the segment, clamped at its ends', () => {
    expect(distToSegment2(5, 3, 0, 0, 10, 0)).toBe(9)
    expect(distToSegment2(-4, 0, 0, 0, 10, 0)).toBe(16)
  })
})
