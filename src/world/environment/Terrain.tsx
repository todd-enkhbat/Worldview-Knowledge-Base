import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial } from 'three'
import { LAYER } from '../layers.ts'
import { PALETTE } from './materials.ts'
import { PERISTYLE_RADIUS } from './layout.ts'

// The land around the time column, so the world reads as a place rather than a tower on an
// endless slab: a shallow terraced basin just outside the peristyle, rolling cut-stone
// terraces, then a ring of ridged ranges on the horizon tall enough to stay on the skyline
// from the present landing. Deterministic (seeded value noise), built once per height class.
//
// Brutalist: heights are quantised into terraces (like contour-cut concrete), faces are flat
// shaded, and a faint ember survey line marks every CONTOUR units of height. Decorative only:
// nothing walks or collides on it, and nodes stay inside the basin in practice (anchors near
// the column), so it never hides a memory.

const INNER_R = PERISTYLE_RADIUS + 16
const OUTER_R = 4200
const RINGS = 150
const SEGMENTS = 288
const TERRACE = 3.5
const CONTOUR = 24
/** Lift over the floor plane so the inner rim never z-fights with it. */
const LIFT = 0.15

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ 0x5bd1e995
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function noise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function fbm(x: number, y: number, octaves: number): number {
  let s = 0
  let amp = 0.5
  for (let i = 0; i < octaves; i++) {
    s += amp * noise(x, y)
    x = x * 2.03 + 11.7
    y = y * 2.03 - 5.3
    amp *= 0.5
  }
  return s
}

/** Ridged multifractal in [0, 1]: sharp crests, the silhouette of a range. */
function ridged(x: number, y: number): number {
  let s = 0
  let amp = 0.55
  let w = 1
  for (let i = 0; i < 5; i++) {
    let n = 1 - Math.abs(2 * noise(x, y) - 1)
    n *= n * w
    w = Math.min(1, n * 2)
    s += n * amp
    x = x * 2.1 + 3.1
    y = y * 2.1 + 7.9
    amp *= 0.5
  }
  return Math.min(1, s)
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Height of the land at (x, z); `peak` is the tallest summit. Exported for tests. */
export function terrainHeight(x: number, z: number, peak: number): number {
  const r = Math.hypot(x, z)
  const basin = smooth(INNER_R, INNER_R + 260, r) * (4 + 34 * fbm(x / 210, z / 210, 4))
  const hills = smooth(380, 900, r) * 70 * fbm(x / 420 + 40, z / 420 - 17, 4)
  const range = smooth(800, 1700, r) * (1 - 0.35 * smooth(3000, OUTER_R, r)) * peak * ridged(x / 760, z / 760)
  const h = basin + hills + range
  // Terraces: hard steps in the near land, loosening on the distant ranges.
  const step = TERRACE * (1 + r / 600)
  const q = Math.floor(h / step) * step
  const k = smooth(0.82, 1, (h - q) / step)
  return q + step * k
}

const LOW = new Color('#24221f')
const MID = new Color(PALETTE.concreteDark)
const HIGH = new Color(PALETTE.bone)

export function buildTerrainGeometry(peak: number): BufferGeometry {
  const nV = (RINGS + 1) * SEGMENTS
  const pos = new Float32Array(nV * 3)
  const col = new Float32Array(nV * 3)
  const c = new Color()
  for (let i = 0; i <= RINGS; i++) {
    // Geometric ring spacing: dense near the column, sparse on the horizon.
    const r = INNER_R * Math.pow(OUTER_R / INNER_R, i / RINGS)
    for (let j = 0; j < SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const y = terrainHeight(x, z, peak) + LIFT
      const o = (i * SEGMENTS + j) * 3
      pos[o] = x
      pos[o + 1] = y
      pos[o + 2] = z
      const t = Math.min(1, y / Math.max(1, peak))
      c.copy(LOW).lerp(MID, smooth(0, 0.25, t)).lerp(HIGH, smooth(0.55, 0.95, t) * 0.55)
      col[o] = c.r
      col[o + 1] = c.g
      col[o + 2] = c.b
    }
  }
  const idx = new Uint32Array(RINGS * SEGMENTS * 6)
  let k = 0
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * SEGMENTS + j
      const b = i * SEGMENTS + ((j + 1) % SEGMENTS)
      const cc = a + SEGMENTS
      const d = b + SEGMENTS
      // Counter-clockwise seen from above (+Y normals).
      idx[k++] = a
      idx[k++] = b
      idx[k++] = cc
      idx[k++] = b
      idx[k++] = d
      idx[k++] = cc
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('color', new BufferAttribute(col, 3))
  g.setIndex(new BufferAttribute(idx, 1))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

function createTerrainMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.45 })
  const ember = new Color(PALETTE.ember).multiplyScalar(0.9)
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uEmber = { value: ember }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTerrainY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainY = position.y;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vTerrainY;\nuniform vec3 uEmber;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Survey contour every ${CONTOUR} u: a thin ember line, anti-aliased by its derivative.
          float f = vTerrainY / ${CONTOUR.toFixed(1)};
          float w = fwidth(f);
          float line = 1.0 - smoothstep(0.0, 1.5 * w, abs(fract(f + 0.5) - 0.5));
          totalEmissiveRadiance += uEmber * line * 0.35;
        }`,
      )
  }
  return m
}

/** Peak height for a column of height yMax, bucketed so scrubbing does not rebuild the land. */
export function terrainPeak(yMax: number): number {
  return Math.max(260, Math.ceil((yMax * 0.55) / 100) * 100)
}

export function Terrain({ yMax }: { yMax: number }) {
  const peak = terrainPeak(yMax)
  const geometry = useMemo(() => buildTerrainGeometry(peak), [peak])
  const material = useMemo(createTerrainMaterial, [])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])
  return <mesh name="terrain" geometry={geometry} material={material} layers={LAYER.SOLID} raycast={() => {}} />
}
