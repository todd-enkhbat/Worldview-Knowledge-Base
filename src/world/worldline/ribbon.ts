import { BufferAttribute, BufferGeometry } from 'three'
import type { WorldlinePath } from './path.ts'

export class RibbonBuffers {
  readonly geometry = new BufferGeometry()
  private capacity = 0
  private builtVersion = -1
  private builtPath: WorldlinePath | null = null

  constructor() { this.geometry.setDrawRange(0, 0) }

  /** Write the path into the vertex buffers (2 vertices per sample). */
  update(path: WorldlinePath): void {
    if (path === this.builtPath && path.version === this.builtVersion) return
    const n = path.count
    // An empty knowledge world has no memories and therefore no vertex attributes yet.
    // Clear the draw count without reading absent buffers; later births allocate normally.
    if (n === 0) {
      this.geometry.setDrawRange(0, 0)
      this.builtPath = path
      this.builtVersion = path.version
      return
    }
    if (n > this.capacity) this.allocate(Math.max(n, Math.ceil(this.capacity * 1.5), 64))
    const g = this.geometry
    const pos = g.getAttribute('position') as BufferAttribute
    const tan = g.getAttribute('aTangent') as BufferAttribute
    const arc = g.getAttribute('aArc') as BufferAttribute
    const born = g.getAttribute('aBorn') as BufferAttribute
    const P = pos.array as Float32Array
    const T = tan.array as Float32Array
    const A = arc.array as Float32Array
    const B = born.array as Float32Array
    const s = path.samples
    for (let i = 0; i < n; i++) {
      const o = 3 * i
      // Central differences (one-sided at the ends).
      const a = 3 * Math.max(0, i - 1)
      const b = 3 * Math.min(n - 1, i + 1)
      let tx = s[b] - s[a]
      let ty = s[b + 1] - s[a + 1]
      let tz = s[b + 2] - s[a + 2]
      const l = Math.hypot(tx, ty, tz)
      if (l > 1e-9) {
        tx /= l
        ty /= l
        tz /= l
      } else {
        tx = 0
        ty = 1
        tz = 0
      }
      for (let v = 0; v < 2; v++) {
        const q = 2 * i + v
        P[3 * q] = s[o]
        P[3 * q + 1] = s[o + 1]
        P[3 * q + 2] = s[o + 2]
        T[3 * q] = tx
        T[3 * q + 1] = ty
        T[3 * q + 2] = tz
        A[q] = path.arc[i]
        B[q] = path.born[i]
      }
    }
    for (const attr of [pos, tan, arc, born]) {
      attr.clearUpdateRanges()
      attr.addUpdateRange(0, attr.itemSize * 2 * n)
      attr.needsUpdate = true
    }
    g.setDrawRange(0, n > 1 ? 6 * (n - 1) : 0)
    this.builtPath = path
    this.builtVersion = path.version
  }

  private allocate(samples: number): void {
    const g = this.geometry
    // Replacing buffer attributes must release the prior GPU allocation first. CPU data
    // remains owned here, and Three recreates its GPU bindings on the next render.
    if (this.capacity > 0) g.dispose()
    const verts = 2 * samples
    g.setAttribute('position', new BufferAttribute(new Float32Array(3 * verts), 3))
    g.setAttribute('aTangent', new BufferAttribute(new Float32Array(3 * verts), 3))
    g.setAttribute('aArc', new BufferAttribute(new Float32Array(verts), 1))
    g.setAttribute('aBorn', new BufferAttribute(new Float32Array(verts), 1))
    const side = new Float32Array(verts)
    for (let q = 0; q < verts; q++) side[q] = q % 2 === 0 ? -1 : 1
    g.setAttribute('aSide', new BufferAttribute(side, 1))
    const index = new Uint32Array(6 * Math.max(0, samples - 1))
    for (let i = 0; i < samples - 1; i++) {
      const a = 2 * i
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], 6 * i)
    }
    g.setIndex(new BufferAttribute(index, 1))
    this.capacity = samples
  }

  dispose(): void {
    this.geometry.dispose()
    // StrictMode can replay effect setup with the same memoized resources. Invalidate
    // only the cache; retained CPU attributes can safely repopulate renderer bindings.
    this.builtVersion = -1
    this.builtPath = null
  }
}
