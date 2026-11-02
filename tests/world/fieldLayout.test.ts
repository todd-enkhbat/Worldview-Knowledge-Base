import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '../../src/domain/types.ts'
import { computeFieldLayout, layoutBounds } from '../../src/world/field/layout.ts'

const rec = (id: string, anchor: [number, number], links: string[] = [], tags: string[] = []): NodeRecord =>
  ({ id, anchorXZ: anchor, links: links.map((t) => ({ targetId: t, kind: 'supports', createdAt: 0 })), tags, deletedAt: null }) as unknown as NodeRecord

const dist = (m: Map<string, [number, number]>, a: string, b: string) => Math.hypot(m.get(a)![0] - m.get(b)![0], m.get(a)![1] - m.get(b)![1])

describe('field layout', () => {
  const world = [
    rec('a', [40, 0], ['b']),
    rec('b', [-40, 0]),
    rec('c', [0, 60], [], ['x']),
    rec('d', [0, -60], [], ['x']),
    rec('e', [70, 70]),
    rec('f', [-70, -70]),
  ]

  it('is deterministic and frees notes from their rings: links and tags pull together', () => {
    const one = computeFieldLayout({ records: world })
    const two = computeFieldLayout({ records: [...world].reverse() })
    expect([...one]).toEqual([...two])
    // Linked a–b and tagged c–d end closer than the unrelated e–f.
    expect(dist(one, 'a', 'b')).toBeLessThan(dist(one, 'e', 'f'))
    expect(dist(one, 'c', 'd')).toBeLessThan(dist(one, 'e', 'f'))
    // Nothing sits on top of anything else.
    const ids = [...one.keys()]
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(dist(one, ids[i], ids[j])).toBeGreaterThan(4)
  })

  it('warm-starts: adding a note barely moves the others', () => {
    const before = computeFieldLayout({ records: world })
    const after = computeFieldLayout({ records: [...world, rec('g', [10, 10], ['a'])], previous: before })
    for (const id of before.keys()) {
      const moved = Math.hypot(before.get(id)![0] - after.get(id)![0], before.get(id)![1] - after.get(id)![1])
      expect(moved).toBeLessThan(id === 'a' ? 12 : 6)
    }
    expect(layoutBounds(after).radius).toBeGreaterThanOrEqual(30)
  })

  it('uses semantic neighbours when vectors are given', () => {
    const v = (x: number, y: number) => new Float32Array([x, y])
    const vectors = new Map([['e', v(1, 0)], ['f', v(0.99, 0.141)], ['a', v(0, 1)], ['b', v(-1, 0)], ['c', v(0, -1)], ['d', v(-0.7, -0.7)]])
    const sem = computeFieldLayout({ records: world, vectors })
    const plain = computeFieldLayout({ records: world })
    expect(dist(sem, 'e', 'f')).toBeLessThan(dist(plain, 'e', 'f'))
  })
})

describe('field layout at scale', () => {
  it('gives a big world room: median nearest-neighbour spacing ≥ 18 u', () => {
    let seed = 7
    const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const big = Array.from({ length: 600 }, (_, i) => rec(`n${i}`, [r() * 160 - 80, r() * 160 - 80], i > 0 ? [`n${Math.floor(r() * i)}`] : [], [`t${i % 25}`]))
    const layout = computeFieldLayout({ records: big })
    const pts = [...layout.values()]
    const nn = pts.map((p, i) => Math.min(...pts.map((q, j) => (i === j ? Infinity : Math.hypot(p[0] - q[0], p[1] - q[1])))))
    nn.sort((a, b) => a - b)
    expect(nn[nn.length >> 1]).toBeGreaterThanOrEqual(17.9)
  })

  it('does not keep inflating across warm-started re-layouts', () => {
    let seed = 11
    const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const world = Array.from({ length: 300 }, (_, i) => rec(`n${i}`, [r() * 120 - 60, r() * 120 - 60], i > 0 ? [`n${Math.floor(r() * i)}`] : []))
    const radius = (m: Map<string, [number, number]>) => Math.max(...[...m.values()].map(([x, z]) => Math.hypot(x, z)))
    let layout = computeFieldLayout({ records: world })
    const first = radius(layout)
    for (let k = 0; k < 5; k++) {
      world.push(rec(`extra${k}`, [0, 0], ['n0']))
      layout = computeFieldLayout({ records: world, previous: layout })
    }
    expect(radius(layout) / first).toBeLessThan(1.25)
  })

  it('leaves a small world’s scale alone', async () => {
    const { spacingScale } = await import('../../src/world/field/layout.ts')
    expect(spacingScale([0, 30, 60], [0, 0, 0])).toBe(1)
    expect(spacingScale([0, 9, 18], [0, 0, 0])).toBe(2)
  })
})
