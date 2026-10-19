import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, InstancedInterleavedBuffer, InterleavedBufferAttribute, Vector3 } from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { useWorld } from '../../app/store.ts'
import { registerDevApi } from '../../app/devApi.ts'
import type { LinkKind } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { getPoseTable } from '../poses.ts'
import { emphasisLevel, sampleEmphasis } from '../nodes/emphasis.ts'
import { KIND_PRECEDENCE, LINK_STYLE, buildTypedLinks, type TypedLink } from './style.ts'

export { buildTypedLinks, LINK_STYLE, KIND_PRECEDENCE, linkSentence } from './style.ts'
export type { TypedLink } from './style.ts'
export { LinkHover } from './LinkHover.tsx'

// <LinkLayer/>: explicit links (record.links) drawn by kind (style.ts) with screen-space wide
// lines, one LineSegments2 per kind (≤ 5 draw calls). Each link is one segment, two when it has
// a midpoint gap (contradicts), plus two for an arrowhead (derives, influenced-by). Arrowheads
// keep a constant on-screen size, so the buffers are rewritten whenever the poses or the
// camera move; colours follow the emphasis (selection / hover / near) and unborn ends fade.

/** Segments per link: up to two body halves plus two arrowhead strokes. */
const SEGS_PER_LINK = 4
const ARROW_PX = 9
/** The arrow tip stops this many px short of the downstream node, so its mesh does not hide it. */
const TIP_BACK_PX = 14
const ARROW_HALF_ANGLE = 0.42
/** Brightness: base, an emphasised end, the hovered end, the selected end; unborn ends fade. */
const BASE = 1.15
const NEAR = 1.7
const LIT = 2.4
const SELECTED = 3
const UNBORN_FADE = 0.3

function capacityFor(n: number): number {
  let c = 16
  while (c < n) c <<= 1
  return c
}

interface KindLines {
  kind: LinkKind
  links: TypedLink[]
  lines: LineSegments2
  pos: Float32Array
  col: Float32Array
  dist: Float32Array
  bufs: InstancedInterleavedBuffer[]
  base: Color
}

function makeKindLines(kind: LinkKind, links: TypedLink[], material: LineMaterial): KindLines {
  const cap = capacityFor(links.length * SEGS_PER_LINK)
  const g = new LineSegmentsGeometry()
  const pos = new Float32Array(cap * 6)
  const col = new Float32Array(cap * 6)
  const dist = new Float32Array(cap * 2)
  const posBuf = new InstancedInterleavedBuffer(pos, 6, 1)
  const colBuf = new InstancedInterleavedBuffer(col, 6, 1)
  const distBuf = new InstancedInterleavedBuffer(dist, 2, 1)
  g.setAttribute('instanceStart', new InterleavedBufferAttribute(posBuf, 3, 0))
  g.setAttribute('instanceEnd', new InterleavedBufferAttribute(posBuf, 3, 3))
  g.setAttribute('instanceColorStart', new InterleavedBufferAttribute(colBuf, 3, 0))
  g.setAttribute('instanceColorEnd', new InterleavedBufferAttribute(colBuf, 3, 3))
  g.setAttribute('instanceDistanceStart', new InterleavedBufferAttribute(distBuf, 1, 0))
  g.setAttribute('instanceDistanceEnd', new InterleavedBufferAttribute(distBuf, 1, 1))
  g.instanceCount = 0
  const lines = new LineSegments2(g, material)
  lines.name = `links-${kind}`
  lines.layers.set(LAYER.SOLID)
  // Endpoints move every pose write; culling would need a bounds pass per write.
  lines.frustumCulled = false
  return { kind, links, lines, pos, col, dist, bufs: [posBuf, colBuf, distBuf], base: new Color(LINK_STYLE[kind].color) }
}

function makeMaterial(kind: LinkKind): LineMaterial {
  const s = LINK_STYLE[kind]
  const m = new LineMaterial({ vertexColors: true, linewidth: s.width, worldUnits: false, toneMapped: false })
  if (s.dash) {
    m.dashed = true
    m.dashSize = s.dash[0]
    m.gapSize = s.dash[1]
    m.dashScale = 1
  }
  return m
}

/** Dev: per-kind link and segment counts from the last rebuild (__wv.linkStats()). */
let lastStats: Record<string, { links: number; segments: number }> = {}
registerDevApi('linkStats', () => lastStats)

const _a = new Vector3()
const _b = new Vector3()
const _d = new Vector3()
const _t = new Vector3()
const _side = new Vector3()
const _view = new Vector3()

export function LinkLayer() {
  const nodes = useWorld((s) => s.nodes)
  const size = useThree((s) => s.size)
  const links = useMemo(() => buildTypedLinks(nodes), [nodes])
  const materials = useMemo(() => Object.fromEntries(KIND_PRECEDENCE.map((k) => [k, makeMaterial(k)])) as Record<LinkKind, LineMaterial>, [])
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials])
  useEffect(() => {
    for (const m of Object.values(materials)) m.resolution.set(size.width, size.height)
  }, [materials, size])

  const groups = useMemo(() => {
    const out: KindLines[] = []
    for (const k of KIND_PRECEDENCE) {
      const ls = links.filter((l) => l.kind === k)
      if (ls.length) out.push(makeKindLines(k, ls, materials[k]))
    }
    return out
  }, [links, materials])
  useEffect(() => () => groups.forEach((g) => g.lines.geometry.dispose()), [groups])

  const st = useRef({ key: '', groups: null as KindLines[] | null, h: 0 })

  useFrame((state) => {
    const table = getPoseTable()
    const cam = state.camera
    const e = sampleEmphasis(cam, state.clock.elapsedTime)
    const s = st.current
    const key = `${table.version}|${cam.matrixWorld.elements.join(',')}|${e.selected}|${e.hovered}|${e.near}`
    if (key === s.key && s.groups === groups && s.h === size.height) return
    s.key = key
    s.groups = groups
    s.h = size.height
    const stats: typeof lastStats = {}
    const fov = (cam as { fov?: number }).fov ?? 50
    const pxPerUnitAt1 = size.height / (2 * Math.tan((fov * Math.PI) / 360))

    for (const g of groups) {
      const style = LINK_STYLE[g.kind]
      let seg = 0
      const put = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, k: number) => {
        const o = seg * 6
        g.pos[o] = ax
        g.pos[o + 1] = ay
        g.pos[o + 2] = az
        g.pos[o + 3] = bx
        g.pos[o + 4] = by
        g.pos[o + 5] = bz
        g.col[o] = g.col[o + 3] = g.base.r * k
        g.col[o + 1] = g.col[o + 4] = g.base.g * k
        g.col[o + 2] = g.col[o + 5] = g.base.b * k
        g.dist[seg * 2] = 0
        g.dist[seg * 2 + 1] = Math.hypot(bx - ax, by - ay, bz - az)
        seg++
      }
      for (const l of g.links) {
        const ra = table.index.get(l.from)
        const rb = table.index.get(l.to)
        if (ra === undefined || rb === undefined) continue
        _a.set(table.pos[ra * 3], table.pos[ra * 3 + 1], table.pos[ra * 3 + 2])
        _b.set(table.pos[rb * 3], table.pos[rb * 3 + 1], table.pos[rb * 3 + 2])
        const la = emphasisLevel(e, l.from)
        const lb = emphasisLevel(e, l.to)
        const hov = l.from === e.hovered || l.to === e.hovered
        let k = la === 2 || lb === 2 ? SELECTED : hov ? LIT : la === 1 || lb === 1 ? NEAR : BASE
        if (table.born[ra] !== 1 || table.born[rb] !== 1) k *= UNBORN_FADE

        if (style.gap > 0) {
          _t.lerpVectors(_a, _b, 0.5 - style.gap / 2)
          put(_a.x, _a.y, _a.z, _t.x, _t.y, _t.z, k)
          _t.lerpVectors(_a, _b, 0.5 + style.gap / 2)
          put(_t.x, _t.y, _t.z, _b.x, _b.y, _b.z, k)
        } else {
          put(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, k)
        }

        if (style.arrow) {
          _d.subVectors(_b, _a)
          const len = _d.length()
          if (len < 1e-4) continue
          _d.divideScalar(len)
          const unit = Math.max(_b.distanceTo(cam.position), 1e-3) / pxPerUnitAt1
          const head = Math.min(ARROW_PX * unit, len * 0.3)
          _t.copy(_b).addScaledVector(_d, -Math.min(TIP_BACK_PX * unit, len * 0.3))
          _view.subVectors(cam.position, _t).normalize()
          _side.crossVectors(_d, _view).normalize()
          const c = Math.cos(ARROW_HALF_ANGLE) * head
          const sn = Math.sin(ARROW_HALF_ANGLE) * head
          put(_t.x, _t.y, _t.z, _t.x - _d.x * c + _side.x * sn, _t.y - _d.y * c + _side.y * sn, _t.z - _d.z * c + _side.z * sn, k)
          put(_t.x, _t.y, _t.z, _t.x - _d.x * c - _side.x * sn, _t.y - _d.y * c - _side.y * sn, _t.z - _d.z * c - _side.z * sn, k)
        }
      }
      g.lines.geometry.instanceCount = seg
      for (const b of g.bufs) b.needsUpdate = true
      stats[g.kind] = { links: g.links.length, segments: seg }
    }
    lastStats = stats
  }, -1)

  return (
    <group name="links">
      {groups.map((g) => (
        <primitive key={g.kind} object={g.lines} />
      ))}
    </group>
  )
}
