import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineBasicMaterial, LineSegments } from 'three'
import { useWorld } from '../../app/store.ts'
import type { NodeRecord } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { getPoseTable } from '../poses.ts'
import { emphasisLevel, sampleEmphasis } from '../nodes/emphasis.ts'

// <LinkLayer/>: explicit links (record.links) as plain thin lines between the current
// poses. One LineSegments with a dynamic buffer: positions are rewritten when the pose table
// changes, colours when the emphasis (selection / hover / near) changes. Dim by default,
// ember when either endpoint is emphasised, signal-tinted when one is selected.

export interface LinkPairs {
  a: string[]
  b: string[]
}

/** Undirected, de-duplicated links whose endpoints are both live. Exported for tests. */
export function buildLinkPairs(nodes: ReadonlyMap<string, NodeRecord>): LinkPairs {
  const seen = new Set<string>()
  const a: string[] = []
  const b: string[] = []
  for (const n of nodes.values()) {
    for (const l of n.links) {
      const t = l.targetId
      if (t === n.id || !nodes.has(t)) continue
      const key = n.id < t ? `${n.id}|${t}` : `${t}|${n.id}`
      if (seen.has(key)) continue
      seen.add(key)
      a.push(n.id)
      b.push(t)
    }
  }
  return { a, b }
}

const DIM = new Color('#8d8a84').multiplyScalar(0.28)
const LIT = new Color('#e8b04a').multiplyScalar(2.6)
const NEAR = new Color('#e8b04a').multiplyScalar(1.5)
const SELECTED = new Color('#ff4a1c').multiplyScalar(3)
const UNBORN_FADE = 0.35

function capacityFor(n: number): number {
  let c = 16
  while (c < n) c <<= 1
  return c
}

function makeLines(capacity: number, material: LineBasicMaterial): LineSegments {
  const g = new BufferGeometry()
  const pos = new BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(DynamicDrawUsage)
  const col = new BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(DynamicDrawUsage)
  g.setAttribute('position', pos)
  g.setAttribute('color', col)
  g.setDrawRange(0, 0)
  const lines = new LineSegments(g, material)
  lines.name = 'links'
  lines.layers.set(LAYER.SOLID)
  // Endpoints move every pose write; culling would need a bounds pass per write for a
  // single draw call.
  lines.frustumCulled = false
  return lines
}

export function LinkLayer() {
  const nodes = useWorld((s) => s.nodes)
  const pairs = useMemo(() => buildLinkPairs(nodes), [nodes])
  const material = useMemo(() => new LineBasicMaterial({ vertexColors: true, toneMapped: false }), [])
  useEffect(() => () => material.dispose(), [material])
  const capacity = capacityFor(pairs.a.length)
  const lines = useMemo(() => makeLines(capacity, material), [capacity, material])
  useEffect(() => () => lines.geometry.dispose(), [lines])

  const st = useRef({
    version: -1,
    pairs: null as LinkPairs | null,
    lines: null as LineSegments | null,
    sel: null as string | null,
    hov: null as string | null,
    near: null as string | null,
  })

  useFrame((state) => {
    const s = st.current
    const table = getPoseTable()
    const e = sampleEmphasis(state.camera, state.clock.elapsedTime)
    const structural = s.pairs !== pairs || s.lines !== lines
    const moved = structural || s.version !== table.version
    const recolor = moved || e.selected !== s.sel || e.hovered !== s.hov || e.near !== s.near
    if (!moved && !recolor) return

    const n = pairs.a.length
    const pos = lines.geometry.getAttribute('position') as BufferAttribute
    const col = lines.geometry.getAttribute('color') as BufferAttribute
    const P = pos.array as Float32Array
    const C = col.array as Float32Array
    for (let i = 0; i < n; i++) {
      const ra = table.index.get(pairs.a[i])
      const rb = table.index.get(pairs.b[i])
      const o = i * 6
      if (moved) {
        if (ra === undefined || rb === undefined) {
          P.fill(0, o, o + 6)
        } else {
          P[o] = table.pos[ra * 3]
          P[o + 1] = table.pos[ra * 3 + 1]
          P[o + 2] = table.pos[ra * 3 + 2]
          P[o + 3] = table.pos[rb * 3]
          P[o + 4] = table.pos[rb * 3 + 1]
          P[o + 5] = table.pos[rb * 3 + 2]
        }
      }
      if (recolor) {
        const la = emphasisLevel(e, pairs.a[i])
        const lb = emphasisLevel(e, pairs.b[i])
        const c =
          la === 2 || lb === 2
            ? SELECTED
            : (la === 1 && pairs.a[i] === e.hovered) || (lb === 1 && pairs.b[i] === e.hovered)
              ? LIT
              : la === 1 || lb === 1
                ? NEAR
                : DIM
        const unborn = ra === undefined || rb === undefined || table.born[ra] !== 1 || table.born[rb] !== 1
        const k = unborn ? UNBORN_FADE : 1
        C[o] = C[o + 3] = c.r * k
        C[o + 1] = C[o + 4] = c.g * k
        C[o + 2] = C[o + 5] = c.b * k
      }
    }
    if (moved) pos.needsUpdate = true
    if (recolor) col.needsUpdate = true
    lines.geometry.setDrawRange(0, n * 2)

    s.version = table.version
    s.pairs = pairs
    s.lines = lines
    s.sel = e.selected
    s.hov = e.hovered
    s.near = e.near
  }, -1)

  return pairs.a.length > 0 ? <primitive object={lines} /> : null
}
