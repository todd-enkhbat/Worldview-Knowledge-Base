import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  EdgesGeometry,
  IcosahedronGeometry,
  LatheGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Procedural node geometry. Every archetype is centred on its pose so a single node basis
// (pose · yaw · scale) places all of its parts; local offsets are baked in here. All parts
// are built from indexed primitives with position/normal/uv so they merge freely.

const UP = new Vector3(0, 1, 0)
const _a = new Vector3()
const _q = new Quaternion()

/** A prism of `sides` faces from a to b. sides=8 rotated by π/8 reads as a chamfered bar. */
export function beam(a: Vector3, b: Vector3, radius: number, sides = 4, chamfer = false): BufferGeometry {
  const len = a.distanceTo(b)
  const g = new CylinderGeometry(radius, radius, len, sides, 1, false)
  g.rotateY(chamfer ? Math.PI / sides : Math.PI / 4)
  _a.subVectors(b, a).normalize()
  _q.setFromUnitVectors(UP, _a)
  g.applyQuaternion(_q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

/** Merges and disposes the inputs. */
export function merge(parts: BufferGeometry[]): BufferGeometry {
  const out = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!out) throw new Error('node geometry merge failed')
  return out
}

/** Thin beams along the hard edges of `source` (a wireframe without triangle diagonals). */
export function edgeBeams(source: BufferGeometry, radius: number, thresholdDeg = 20): BufferGeometry {
  const edges = new EdgesGeometry(source, thresholdDeg)
  const p = edges.getAttribute('position')
  const parts: BufferGeometry[] = []
  const a = new Vector3()
  const b = new Vector3()
  for (let i = 0; i < p.count; i += 2) {
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, i + 1)
    if (a.distanceToSquared(b) > 1e-8) parts.push(beam(a, b, radius, 4))
  }
  edges.dispose()
  return merge(parts)
}

/** The 12 edges of an axis-aligned cube of half-size h, as endpoint pairs. */
function cubeEdges(h: number): [Vector3, Vector3][] {
  const out: [Vector3, Vector3][] = []
  const s = [-h, h]
  for (const y of s) for (const z of s) out.push([new Vector3(-h, y, z), new Vector3(h, y, z)])
  for (const x of s) for (const z of s) out.push([new Vector3(x, -h, z), new Vector3(x, h, z)])
  for (const x of s) for (const y of s) out.push([new Vector3(x, y, -h), new Vector3(x, y, h)])
  return out
}

function cubeCorners(h: number): Vector3[] {
  const out: Vector3[] = []
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) out.push(new Vector3(x, y, z))
  return out
}

// ─── idea: faceted crystal ──────────────────────────────────────────────────────────────

/**
 * A quartz-like crystal: hexagonal prism with irregular pyramidal terminations, ~1.25 u
 * tall. Non-indexed and flat-shaded, with a barycentric attribute (aBary) that the crystal
 * material uses to light its facet edges from inside.
 */
export function crystalGeometry(): BufferGeometry {
  const ring = (y: number, r: number, twist: number, wobble: number[]) =>
    Array.from({ length: 6 }, (_, k) => {
      const t = (k / 6) * Math.PI * 2 + twist
      const rr = r * wobble[k]
      return new Vector3(Math.cos(t) * rr, y + (k % 2 ? 0.03 : -0.02), Math.sin(t) * rr)
    })
  const upper = ring(0.2, 0.3, 0.05, [1, 0.86, 1.04, 0.9, 1.08, 0.94])
  const lower = ring(-0.22, 0.27, 0.0, [0.95, 1.05, 0.9, 1.0, 0.92, 1.08])
  const top = new Vector3(0.04, 0.68, -0.02)
  const bottom = new Vector3(-0.03, -0.58, 0.02)
  const tris: Vector3[] = []
  for (let k = 0; k < 6; k++) {
    const n = (k + 1) % 6
    tris.push(top, upper[n], upper[k]) // upper termination
    tris.push(upper[k], upper[n], lower[n], upper[k], lower[n], lower[k]) // prism wall
    tris.push(bottom, lower[k], lower[n]) // lower termination
  }
  const pos = new Float32Array(tris.length * 3)
  const bary = new Float32Array(tris.length * 3)
  tris.forEach((v, i) => {
    v.toArray(pos, i * 3)
    bary[i * 3 + (i % 3)] = 1
  })
  // Prism walls are two triangles per quad; their shared diagonal must not glow. Setting
  // the coordinate opposite that edge to 1 on all three vertices removes it from the min().
  const hide = (tri: number, opposite: number) => {
    for (let v = 0; v < 3; v++) bary[(tri * 3 + v) * 3 + opposite] = 1
  }
  for (let k = 0; k < 6; k++) {
    hide(k * 4 + 1, 1) // (u_k, u_n, l_n): diagonal u_k–l_n is opposite vertex 1
    hide(k * 4 + 2, 2) // (u_k, l_n, l_k): diagonal u_k–l_n is opposite vertex 2
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aBary', new BufferAttribute(bary, 3))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

// ─── entity: obsidian monolith ──────────────────────────────────────────────────────────

/** 1 : 4 : 0.25 slab, 3 u tall, centred on the pose. */
export const MONOLITH = { w: 0.75, h: 3, d: 0.1875 } as const

export function monolithGeometry(): BufferGeometry {
  return new BoxGeometry(MONOLITH.w, MONOLITH.h, MONOLITH.d)
}

/** Ember levitation seam glowing under the monolith's base. */
export function monolithSeamGeometry(): BufferGeometry {
  const g = new BoxGeometry(MONOLITH.w * 1.04, 0.018, MONOLITH.d * 1.3)
  g.translate(0, -MONOLITH.h / 2 - 0.09, 0)
  return g
}

/**
 * Gravitational vector: three tapered segments stacked along +Y over [0, 1], so an
 * instance matrix (start, direction, length) turns it into a dashed field line whose tips
 * point at the attracted node.
 */
export function vectorGeometry(): BufferGeometry {
  const seg = (y0: number, y1: number, r: number) => {
    const g = new ConeGeometry(r, y1 - y0, 5, 1, false)
    g.translate(0, (y0 + y1) / 2, 0)
    return g
  }
  return merge([seg(0, 0.34, 0.045), seg(0.42, 0.68, 0.034), seg(0.76, 1, 0.024)])
}

// ─── lens: astrolabe ────────────────────────────────────────────────────────────────────

export const LENS = { limb: 0.82, ringB: 0.71, ringC: 0.6, disc: 0.52, cone: 2.6 } as const

/** The fixed limb: a brass ring coaxial with the disc (+Z) with 24 graduation ticks. */
export function lensLimbGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [new TorusGeometry(LENS.limb, 0.034, 6, 72)]
  for (let k = 0; k < 24; k++) {
    const t = (k / 24) * Math.PI * 2
    const long = k % 6 === 0
    const tick = new BoxGeometry(long ? 0.16 : 0.08, 0.018, 0.03)
    tick.translate(LENS.limb - 0.07 - (long ? 0.04 : 0), 0, 0)
    tick.rotateZ(t)
    parts.push(tick)
  }
  return merge(parts)
}

export function lensRingGeometry(radius: number, tube = 0.026): BufferGeometry {
  return new TorusGeometry(radius, tube, 6, 72)
}

/** Dark-glass disc, axis +Z. */
export function lensDiscGeometry(): BufferGeometry {
  const g = new CylinderGeometry(LENS.disc, LENS.disc, 0.035, 64, 1)
  g.rotateX(Math.PI / 2)
  return g
}

/** Ember rim around the disc plus a hub at its centre. */
export function lensRimGeometry(): BufferGeometry {
  const hub = new SphereGeometry(0.045, 12, 8)
  return merge([new TorusGeometry(LENS.disc + 0.008, 0.011, 6, 96), hub])
}

/** Open cone from the disc centre along +Z; uv.y runs 1 at the apex to 0 at the rim. */
export function lensConeGeometry(): BufferGeometry {
  const g = new ConeGeometry(0.95, LENS.cone, 40, 1, true)
  g.translate(0, -LENS.cone / 2, 0)
  g.rotateX(-Math.PI / 2)
  return g
}

// ─── document: concrete slab ────────────────────────────────────────────────────────────

export const SLAB = { w: 1.6, h: 2.2, d: 0.25 } as const

export function slabGeometry(): BufferGeometry {
  return new BoxGeometry(SLAB.w, SLAB.h, SLAB.d)
}

/** Ember rule inlaid under the engraved title. */
export function slabRuleGeometry(): BufferGeometry {
  const g = new BoxGeometry(SLAB.w * 0.72, 0.014, 0.008)
  g.translate(0, SLAB.h * 0.17, SLAB.d / 2 + 0.002)
  return g
}

// ─── memory: tesseract ──────────────────────────────────────────────────────────────────

export const TESSERACT = {
  outer: 1.2, // half-size of the outer cube (2.4 u)
  inner: 0.55, // half-size of the inner cube (1.1 u)
  rim: 0.07,
  shell: 1.16, // glass shells sit just inside the rims
  // A lintel over the front face: the spur platform is level with the node's centre, so a
  // plaque under the cube sat below the deck, out of sight; up here it is at eye height.
  plaque: { w: 2.4, h: 0.44, d: 0.1, y: 1.66, z: 1.1 },
} as const

/** Chamfered chrome rims on the 12 outer edges plus corner blocks. */
export function tesseractRimGeometry(): BufferGeometry {
  const h = TESSERACT.outer
  const parts = cubeEdges(h).map(([a, b]) => beam(a, b, TESSERACT.rim, 8, true))
  for (const c of cubeCorners(h)) {
    const box = new BoxGeometry(0.19, 0.19, 0.19)
    box.translate(c.x, c.y, c.z)
    parts.push(box)
  }
  return merge(parts)
}

/** Brass corner struts joining outer and inner cubes, and the plaque hangers. */
export function tesseractStrutGeometry(): BufferGeometry {
  const o = cubeCorners(TESSERACT.outer)
  const i = cubeCorners(TESSERACT.inner)
  const parts = o.map((c, k) => beam(c, i[k], 0.028, 6))
  const p = TESSERACT.plaque
  // Hangers from the nearest outer face (top or bottom) to the plaque's near edge.
  const side = Math.sign(p.y) || 1
  for (const x of [-0.9, 0.9]) {
    parts.push(beam(new Vector3(x, side * TESSERACT.outer, p.z), new Vector3(x, p.y - (side * p.h) / 2, p.z), 0.018, 6))
  }
  return merge(parts)
}

/** HDR edge glow: the inner cube's edges with a node at each corner where a strut lands. */
export function tesseractGlowGeometry(): BufferGeometry {
  const parts = cubeEdges(TESSERACT.inner).map(([a, b]) => beam(a, b, 0.022, 4))
  for (const c of cubeCorners(TESSERACT.inner)) {
    const node = new SphereGeometry(0.045, 10, 6)
    node.translate(c.x, c.y, c.z)
    parts.push(node)
  }
  return merge(parts)
}

export function tesseractPlaqueGeometry(): BufferGeometry {
  const p = TESSERACT.plaque
  const g = new BoxGeometry(p.w, p.h, p.d)
  g.translate(0, p.y, p.z)
  return g
}

export function shellGeometry(halfSize: number): BufferGeometry {
  return new BoxGeometry(halfSize * 2, halfSize * 2, halfSize * 2)
}

// ─── demon ──────────────────────────────────────────────────────────────────────────────

export const DEMON = { body: 0.5, ringIn: 0.64, ringOut: 0.84, tilt: 0.32 } as const

export function demonBodyGeometry(): BufferGeometry {
  return new SphereGeometry(DEMON.body, 48, 32)
}

/** Brass aperture ring in the XZ plane: a thick washer with twelve inward blades. */
export function demonRingGeometry(): BufferGeometry {
  const t = 0.05
  const profile = [
    new Vector2(DEMON.ringIn, -t),
    new Vector2(DEMON.ringOut, -t),
    new Vector2(DEMON.ringOut, t),
    new Vector2(DEMON.ringIn, t),
    new Vector2(DEMON.ringIn, -t),
  ]
  const washer = new LatheGeometry(profile, 96)
  const parts: BufferGeometry[] = [washer]
  for (let k = 0; k < 12; k++) {
    const blade = new BoxGeometry(0.1, 0.06, 0.035)
    blade.translate(DEMON.ringIn - 0.04, 0, 0)
    blade.rotateY((k / 12) * Math.PI * 2 + 0.2)
    parts.push(blade)
  }
  return merge(parts)
}

/** Ember equatorial slit on the dark sphere. */
export function demonSlitGeometry(): BufferGeometry {
  const g = new TorusGeometry(DEMON.body + 0.004, 0.012, 6, 96)
  g.rotateX(Math.PI / 2)
  return g
}

/** Unit wire sphere scaled per instance to demon.radius. */
export function demonFieldGeometry(): BufferGeometry {
  return new IcosahedronGeometry(1, 3)
}

// ─── ghosts: wire silhouettes of unborn nodes ───────────────────────────────────────────

const GHOST_R = 0.012

export function ghostGeometries(): Record<'idea' | 'entity' | 'lens' | 'document' | 'memory' | 'demon', BufferGeometry> {
  const crystal = crystalGeometry()
  const idea = edgeBeams(crystal, GHOST_R, 10)
  crystal.dispose()

  const mono = monolithGeometry()
  const entity = edgeBeams(mono, GHOST_R)
  mono.dispose()

  const slab = slabGeometry()
  const document = edgeBeams(slab, GHOST_R)
  slab.dispose()

  const lensRingA = new TorusGeometry(LENS.limb, GHOST_R, 3, 64)
  const lensRingB = new TorusGeometry(LENS.disc, GHOST_R, 3, 48)
  const lensRingC = new TorusGeometry(LENS.ringB, GHOST_R, 3, 64)
  lensRingC.rotateY(Math.PI / 2)
  const lens = merge([lensRingA, lensRingB, lensRingC])

  const memParts = [
    ...cubeEdges(TESSERACT.outer).map(([a, b]) => beam(a, b, GHOST_R * 1.4)),
    ...cubeEdges(TESSERACT.inner).map(([a, b]) => beam(a, b, GHOST_R)),
  ]
  const o = cubeCorners(TESSERACT.outer)
  const i = cubeCorners(TESSERACT.inner)
  o.forEach((c, k) => memParts.push(beam(c, i[k], GHOST_R)))
  const memory = merge(memParts)

  const ico = new IcosahedronGeometry(DEMON.body, 1)
  const ring = new TorusGeometry(DEMON.ringOut, GHOST_R, 3, 64)
  ring.rotateX(Math.PI / 2)
  const demonEdges = edgeBeams(ico, GHOST_R, 1)
  ico.dispose()
  const demon = merge([demonEdges, ring])

  return { idea, entity, lens, document, memory, demon }
}

// ─── selection reticle ──────────────────────────────────────────────────────────────────

/** Unit-radius ring in the XZ plane with four outward ticks. */
export function reticleGeometry(tube: number, ticks: boolean): BufferGeometry {
  const ring = new TorusGeometry(1, tube, 4, 128)
  ring.rotateX(Math.PI / 2)
  if (!ticks) return ring
  const parts: BufferGeometry[] = [ring]
  for (let k = 0; k < 4; k++) {
    const tick = new BoxGeometry(0.16, tube * 1.6, tube * 1.6)
    tick.translate(1.1, 0, 0)
    tick.rotateY((k / 4) * Math.PI * 2 + Math.PI / 4)
    parts.push(tick)
  }
  return merge(parts)
}
