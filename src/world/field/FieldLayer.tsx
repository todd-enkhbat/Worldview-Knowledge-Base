import { sceneMotionEnabled } from '../camera/cameraFlight.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  LineSegments,
  NearestFilter,
  Points,
  AdditiveBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
} from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { getStore, isRepoReady } from '../../data/repo.ts'
import type { Archetype, LinkKind, NodeRecord } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { LINK_STYLE, buildTypedLinks } from '../links/style.ts'
import { getFieldFrame } from './runtime.ts'
import { FieldVideos, fieldMediaStatus, sceneReveal } from './FieldMedia.tsx'
import { loadSplatBytes } from '../splats/assets.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { createMolecularPacket, molecularBonds, molecularCounts } from './molecules.ts'

// Data-only molecular field: every packet belongs to a record and every bridge to a link.
// All animated offsets are bounded rendering motion around semantic anchors. The reversible
// integer engine and the timeline remain authoritative; no scenery is generated in an empty world.
const EASE = 6
const MAX_GRAINS = 260_000
const IMAGE_GRID = 56
const CURRENT_GRAINS = 280
const MAX_CURRENT_GRAINS = 60_000
const MAX_CARDS = 3

const ARCHETYPE_COLOR: Record<Archetype, string> = {
  idea: '#76c5e2', entity: '#dfad65', lens: '#8ab2ff',
  document: '#a5d0db', memory: '#e8a47a', demon: '#86d6be',
}

// ─── shared GLSL ─────────────────────────────────────────────────────────────────────

const NOTE_FETCH = /* glsl */ `
uniform sampler2D uNotes;
uniform float uN;
// Rows: A = centre, sigma · B = order, born, highlight, condense · C = reveal (a scene showing through).
vec4 noteA(float i) { return texture2D(uNotes, vec2((i + 0.5) / uN, 1.0 / 6.0)); }
vec4 noteB(float i) { return texture2D(uNotes, vec2((i + 0.5) / uN, 0.5)); }
vec4 noteC(float i) { return texture2D(uNotes, vec2((i + 0.5) / uN, 5.0 / 6.0)); }
`

// Depth-writing shaded beads carry the volume. A restrained glow is a separate pass;
// discarding almost every solid sample was what made the old field disappear at overview.
const MOLECULE = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vRole;
varying float vShine;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 0.92 || vAlpha < 0.035 || vRole > 1.5) discard;
  vec3 normal = vec3(d.x, -d.y, sqrt(max(0.0, 1.0 - r2)));
  vec3 light = normalize(vec3(-0.45, 0.6, 1.0));
  float diffuse = 0.24 + 0.76 * max(dot(normal, light), 0.0);
  float specular = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 18.0);
  float rim = 0.4 + 0.6 * normal.z;
  vec3 color = vColor * diffuse * rim * 1.35 + vec3(0.7, 0.85, 0.9) * specular * 0.45;
  gl_FragColor = vec4(color * (0.7 + 0.3 * vAlpha), 1.0);
}
`
const NEBULA_GLOW = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vRole;
varying float vShine;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0 || vAlpha < 0.035 || vRole > 2.5) discard;
  float nucleus = step(2.5, vRole);
  float fog = exp(-r2 * (nucleus > 0.5 ? 4.5 : 3.8));
  float population = vRole > 1.5 && vRole < 2.5 ? 0.006 : vRole > 0.5 && vRole < 1.5 ? 0.022 : 0.009;
  float alpha = fog * mix(population * (0.35 + 0.65 * vShine), 0.58, nucleus) * vAlpha;
  float star = pow(max(0.0, 1.0 - abs(d.x) * 10.0), 5.0) * exp(-abs(d.y) * 5.0)
    + pow(max(0.0, 1.0 - abs(d.y) * 10.0), 5.0) * exp(-abs(d.x) * 5.0);
  alpha += star * (nucleus * 0.26 + step(0.975, vShine) * 0.08) * vAlpha;
  gl_FragColor = vec4(vColor * (nucleus > 0.5 ? 1.5 : 0.95), alpha);
}
`
const SOLID_DOT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  if (dot(d, d) > 0.8 || vAlpha < 0.05) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`
// One bounded motion function keeps the scaffold endpoints attached to their beads.
const MOLECULAR_MOTION = /* glsl */ `
vec3 molecularPoint(vec3 offset, float phase, float role, float sigma, float highlight, float time) {
  vec3 local = offset * (0.95 + 0.04 * min(sigma, 5.0));
  float angle = time * (0.018 + 0.006 * sin(phase * 6.2831));
  float co = cos(angle), si = sin(angle);
  local.xz = mat2(co, -si, si, co) * local.xz;
  vec3 curl = vec3(sin(local.z * 0.18 + time * 0.1), cos(local.x * 0.16 - time * 0.085), sin(local.y * 0.17 + time * 0.09));
  return local + curl * (0.3 + 0.2 * role + highlight * 0.25);
}
`

// ─── clouds ──────────────────────────────────────────────────────────────────────────

const CLOUD_VERT = /* glsl */ `
${NOTE_FETCH}
${MOLECULAR_MOTION}
uniform float uTime;
uniform float uPixel;
uniform float uDpr;
uniform float uPointScale;
attribute float aNote;
attribute vec3 aOff;
attribute vec3 aColor;
attribute vec3 aRand;
attribute vec2 aPlane;
attribute float aRole;
varying vec3 vColor;
varying float vAlpha;
varying float vRole;
varying float vShine;
void main() {
  vec4 a = noteA(aNote);
  vec4 b = noteB(aNote);
  if (b.y < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
  float hl = b.z;
  float cond = b.w;
  float sigma = a.w;
  bool nucleus = aRole > 2.5;
  vec4 mv;
  if (aRand.z > 0.5) {
    vec4 center = modelViewMatrix * vec4(a.xyz + vec3(0.0, 1.5, 0.0), 1.0);
    float card = 7.0 * (0.8 + 0.2 * cond);
    vec3 scatter = aOff * min(sigma, 5.0) * 0.035;
    mv = center + vec4(aPlane.x * card, aPlane.y * card, 0.0, 0.0) + vec4(scatter, 0.0);
  } else if (nucleus) {
    mv = modelViewMatrix * vec4(a.xyz, 1.0);
  } else {
    vec3 local = molecularPoint(aOff, aRand.x, aRole, sigma, hl, uTime);
    mv = modelViewMatrix * vec4(a.xyz + local, 1.0);
  }
  gl_Position = projectionMatrix * mv;
  float size = aRand.z > 0.5 ? 0.34 : nucleus ? aRand.y : (0.55 + 1.15 * sqrt(aRand.y)) * (aRole > 0.5 && aRole < 1.5 ? 1.2 : 1.0);
  float minSize = aRand.z > 0.5 ? 1.0 : (nucleus ? 9.0 : aRand.y > 0.72 ? 2.3 : 0.7) * uDpr;
  float maxSize = (nucleus ? 42.0 : 8.0) * uDpr;
  gl_PointSize = min(clamp(size * uPixel / max(0.1, -mv.z), minSize, maxSize) * uPointScale, 120.0 * uDpr);
  vColor = mix(aColor, vec3(1.0, 0.76, 0.38), hl * 0.55);
  vAlpha = (0.6 + 0.4 * cond) * (1.0 - noteC(aNote).x) * (1.0 + hl * 0.25);
  vRole = aRole;
  vShine = nucleus ? 1.0 : aRand.y;
}
`

const BOND_VERT = /* glsl */ `
${NOTE_FETCH}
${MOLECULAR_MOTION}
uniform float uTime;
attribute float aNote;
attribute vec3 aOff;
attribute vec3 aColor;
attribute float aPhase;
attribute float aRole;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 a = noteA(aNote), b = noteB(aNote);
  vColor = aColor;
  vAlpha = b.y * (1.0 - noteC(aNote).x) * (0.7 + b.z * 0.3);
  vec3 local = molecularPoint(aOff, aPhase, aRole, a.w, b.z, uTime);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(a.xyz + local, 1.0);
}
`
const BOND_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  if (vAlpha < 0.05) discard;
  gl_FragColor = vec4(vColor, 0.24 * vAlpha);
}
`

// ─── currents ────────────────────────────────────────────────────────────────────────

const CURRENT_VERT = /* glsl */ `
${NOTE_FETCH}
uniform float uTime;
uniform float uPixel;
uniform float uDpr;
uniform float uPointScale;
attribute vec2 aEnds;
attribute vec2 aFlow;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
varying float vRole;
varying float vShine;
void main() {
  vec4 A = noteA(aEnds.x);
  vec4 B = noteA(aEnds.y);
  if (noteB(aEnds.x).y < 0.5 || noteB(aEnds.y).y < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
  float u = fract(aFlow.x + uTime * 0.035);
  vec3 p = mix(A.xyz, B.xyz, u);
  vec3 tangent = normalize(B.xyz - A.xyz + vec3(0.001));
  vec3 side = normalize(cross(tangent, vec3(0.0, 1.0, 0.0)) + vec3(0.001));
  vec3 up = normalize(cross(side, tangent));
  float angle = aFlow.y * 6.2831 + uTime * 0.09;
  float radius = 0.6 + (1.0 + aFlow.y * 1.8) * sin(3.14159 * u);
  p += (side * cos(angle) + up * sin(angle)) * radius;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((0.55 + 0.6 * aFlow.y) * uPixel / max(0.1, -mv.z), 1.2 * uDpr, 5.0 * uDpr) * uPointScale;
  float hl = max(noteB(aEnds.x).z, noteB(aEnds.y).z);
  vColor = mix(aColor, vec3(0.95, 0.79, 0.43), 0.25 + hl * 0.5);
  vAlpha = 0.8;
  vRole = 1.0;
  vShine = aFlow.y;
}
`

// ─── helpers ─────────────────────────────────────────────────────────────────────────

function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r())
}

/** An image or scene note's picture as IMAGE_GRID² linear-ish RGB, from its thumbnail. */
const pictures = new Map<string, Float32Array | null>()

/** A note's picture key: its first image, else its scene's thumbnail. */
function pictureKey(r: NodeRecord): { key: string; src: string } | null {
  return pictureKeys(r)[0] ?? null
}

/** The pictures a note shows as cards (up to MAX_CARDS images), else its scene's thumbnail. */
function pictureKeys(r: NodeRecord): { key: string; src: string }[] {
  const imgs = r.attachments.filter((a) => a.kind === 'image').slice(0, MAX_CARDS)
  if (imgs.length) return imgs.map((img) => ({ key: img.blobId, src: img.thumbBlobId ?? img.blobId }))
  if (r.splat?.thumbAssetId) return [{ key: sceneKey(r.splat.thumbAssetId), src: sceneKey(r.splat.thumbAssetId) }]
  return []
}

/** Molecules per real relationship, thinned within a fixed budget for large graphs. */
export const currentGrainsPerLink = (links: number) =>
  links <= 0 ? CURRENT_GRAINS : Math.max(0, Math.min(CURRENT_GRAINS, Math.floor(MAX_CURRENT_GRAINS / links)))

/** Horizontal offset (in card widths) of card j of m: a strip centred on the note. */
export const cardOffset = (j: number, m: number) => (j - (m - 1) / 2) * 1.08

/** Centre weight of a picture's pixel: a scene's subject is in the middle, its backdrop at the edge. */
const centreWeight = (i: number, g: number) => {
  const x = ((i % g) + 0.5) / g - 0.5
  const y = (Math.floor(i / g) + 0.5) / g - 0.5
  return Math.exp(-(x * x + y * y) / (2 * 0.2 * 0.2))
}

/** A pixel of a g×g picture, near its centre (Gaussian, σ = 0.2 of its width). */
function centredPixel(r: () => number, g: number): number {
  const at = (v: number) => Math.min(g - 1, Math.max(0, Math.floor((0.5 + 0.2 * v) * g)))
  return at(gauss(r)) + at(gauss(r)) * g
}

/** Centre-weighted mean colour of a picture, brightened a little (what a scene stains the land with). */
export function meanColour(pic: Float32Array): [number, number, number] {
  const out = [0, 0, 0]
  const n = pic.length / 3
  const g = Math.round(Math.sqrt(n))
  let wsum = 0
  for (let i = 0; i < n; i++) {
    const w = centreWeight(i, g)
    wsum += w
    for (let c = 0; c < 3; c++) out[c] += pic[i * 3 + c] * w
  }
  const m = out.map((v) => v / Math.max(1e-9, wsum))
  const peak = Math.max(m[0], m[1], m[2], 1e-3)
  const k = Math.min(1.2, 0.3 / peak)
  return [m[0] * k, m[1] * k, m[2] * k]
}

registerDevApi('fieldMedia', () => ({
  pictures: [...pictures].map(([id, p]) => ({ id, loaded: !!p })),
  videos: fieldMediaStatus(),
}))

/** Key of a scene note's picture (its thumbnail) in `pictures`. */
const sceneKey = (assetId: string) => `scene:${assetId}`

async function loadPicture(key: string): Promise<Float32Array | null> {
  if (!isRepoReady() || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null
  try {
    const blob = key.startsWith('scene:') ? new Blob([(await loadSplatBytes(key.slice(6))) as Uint8Array<ArrayBuffer>]) : await getStore().getBlob(key)
    if (!blob) return null
    const bmp = await createImageBitmap(blob)
    const g = IMAGE_GRID
    const canvas = new OffscreenCanvas(g, g)
    const ctx = canvas.getContext('2d')!
    // Cover-crop to a square.
    const s = Math.min(bmp.width, bmp.height)
    ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, g, g)
    bmp.close()
    const px = ctx.getImageData(0, 0, g, g).data
    const out = new Float32Array(g * g * 3)
    for (let i = 0; i < g * g; i++) {
      // sRGB → linear so the picture reads true after output encoding.
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.pow(px[i * 4 + c] / 255, 2.2)
    }
    return out
  } catch {
    return null
  }
}

interface Budget {
  cloud: number
  /** Picture cards (0 when the note holds no image). */
  images: number
}

// ─── the layer ───────────────────────────────────────────────────────────────────────

export function FieldLayer() {
  const nodes = useWorld((s) => s.nodes)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const [structure, setStructure] = useState(0)
  const [pictureVersion, setPictureVersion] = useState(0)

  const notesTex = useMemo(() => {
    const t = new DataTexture(new Float32Array(12), 1, 3, RGBAFormat, FloatType)
    t.magFilter = NearestFilter
    t.minFilter = NearestFilter
    t.needsUpdate = true
    return t
  }, [])
  useEffect(() => () => notesTex.dispose(), [notesTex])
  const flowTime = useRef(0)

  const common = useMemo(() => ({ uNotes: { value: notesTex }, uN: { value: 1 }, uTime: { value: 0 }, uPixel: { value: 600 }, uDpr: { value: 1 }, uPointScale: { value: 1 } }), [notesTex])

  const cloudMat = useMemo(
    () => new ShaderMaterial({ vertexShader: CLOUD_VERT, fragmentShader: MOLECULE, uniforms: common, transparent: false, depthWrite: true }),
    [common],
  )
  const cardMat = useMemo(
    () => new ShaderMaterial({ vertexShader: CLOUD_VERT, fragmentShader: SOLID_DOT, uniforms: common, transparent: false, depthWrite: true }),
    [common],
  )
  const currentMat = useMemo(
    () => new ShaderMaterial({ vertexShader: CURRENT_VERT, fragmentShader: MOLECULE, uniforms: common, transparent: false, depthWrite: true }),
    [common],
  )
  const bondMat = useMemo(() => new ShaderMaterial({ vertexShader: BOND_VERT, fragmentShader: BOND_FRAG, uniforms: common, transparent: true, depthWrite: false }), [common])
  const glowUniforms = useMemo(() => ({ ...common, uPointScale: { value: 1.7 } }), [common])
  const glowMat = useMemo(() => new ShaderMaterial({ vertexShader: CLOUD_VERT, fragmentShader: NEBULA_GLOW, uniforms: glowUniforms, transparent: true, depthWrite: false, blending: AdditiveBlending }), [glowUniforms])
  const currentGlowMat = useMemo(() => new ShaderMaterial({ vertexShader: CURRENT_VERT, fragmentShader: NEBULA_GLOW, uniforms: glowUniforms, transparent: true, depthWrite: false, blending: AdditiveBlending }), [glowUniforms])
  useEffect(
    () => () => {
      cloudMat.dispose()
      cardMat.dispose()
      currentMat.dispose()
      bondMat.dispose()
      glowMat.dispose()
      currentGlowMat.dispose()
    },
    [cloudMat, cardMat, currentMat, bondMat, glowMat, currentGlowMat],
  )

  // Pictures for image notes (async; the clouds rebuild when one arrives).
  useEffect(() => {
    let live = true
    for (const r of nodes.values()) {
      for (const pk of pictureKeys(r)) {
        if (pictures.has(pk.key)) continue
        pictures.set(pk.key, null)
        void loadPicture(pk.src).then((pic) => {
          pictures.set(pk.key, pic)
          if (live && pic) setPictureVersion((v) => v + 1)
        })
      }
    }
    return () => {
      live = false
    }
  }, [nodes])

  // Clouds and currents rebuild when the set of notes or the layout changes.
  const { clouds, cards, bonds, currents, glow, currentGlow } = useMemo(() => {
    void structure
    void pictureVersion
    const frame = getFieldFrame()
    const n = frame.ids.length
    const counts = molecularCounts(frame.records, MAX_GRAINS)
    const budgets = frame.records.map((r, i) => ({ cloud: counts[i]!, images: Math.min(MAX_CARDS, r.attachments.filter((a) => a.kind === 'image').length) }))
    const cardGrains = (b: Budget) => b.images * IMAGE_GRID * IMAGE_GRID
    const planned = budgets.reduce((s, b) => s + b.cloud + cardGrains(b), 0)
    const scale = Math.min(1, MAX_GRAINS / Math.max(1, planned))
    const total = n + budgets.reduce((s, b) => s + Math.round(b.cloud * scale) + cardGrains(b), 0)
    const aNote = new Float32Array(total)
    const aOff = new Float32Array(total * 3)
    const aColor = new Float32Array(total * 3)
    const aRand = new Float32Array(total * 3)
    const aPlane = new Float32Array(total * 2)
    const aRole = new Float32Array(total)
    const bondNotes: number[] = [], bondOffsets: number[] = [], bondColors: number[] = [], bondPhases: number[] = [], bondRoles: number[] = []
    const col = new Color()
    const warmWhite = new Color('#fff1dc')
    let k = 0
    for (let i = 0; i < n; i++) {
      const rec = frame.records[i]
      const r = rng(hash(rec.id))
      const base = new Color(ARCHETYPE_COLOR[rec.archetype])
      const pk = pictureKey(rec)
      const pic = pk ? pictures.get(pk.key) : null
      // A scene's cloud is the scene unresolved: nearly all its grains take its colours.
      const share = rec.splat && !budgets[i].images ? 0.9 : 0.6
      const count = Math.round(budgets[i].cloud * scale)
      const packet = createMolecularPacket(rec, count, frame.degree[i])
      const start = k
      for (let c = 0; c < count; c++, k++) {
        aNote[k] = i
        aOff.set(packet.offsets.subarray(c * 3, c * 3 + 3), k * 3)
        if (pic && r() < share) {
          const p = (rec.splat ? centredPixel(r, IMAGE_GRID) : Math.floor(r() * IMAGE_GRID * IMAGE_GRID)) * 3
          col.setRGB(pic[p], pic[p + 1], pic[p + 2])
        } else {
          col.copy(base).lerp(warmWhite, r() * 0.12)
          col.multiplyScalar(packet.roles[c] === 2 ? 0.65 : 0.8 + 0.4 * r())
        }
        aColor.set([col.r, col.g, col.b], k * 3)
        aRand.set([packet.phases[c]!, packet.sizes[c]!, 0], k * 3)
        aRole[k] = packet.roles[c]!
      }
      for (const site of molecularBonds(packet)) {
        bondNotes.push(i)
        bondOffsets.push(packet.offsets[site * 3]!, packet.offsets[site * 3 + 1]!, packet.offsets[site * 3 + 2]!)
        const colorAt = (start + site) * 3
        bondColors.push(aColor[colorAt]!, aColor[colorAt + 1]!, aColor[colorAt + 2]!)
        bondPhases.push(packet.phases[site]!)
        bondRoles.push(packet.roles[site]!)
      }
      // The actual note has one larger luminous nucleus, independent of decorative dust.
      aNote[k] = i
      aColor.set([base.r, base.g, base.b], k * 3)
      aRand.set([r(), 1.5 + rec.thermo.mass * 0.4 + Math.min(frame.degree[i]!, 10) * 0.05, 0], k * 3)
      aRole[k] = 3
      k++
      const m = budgets[i].images
      const keys = pictureKeys(rec)
      for (let j = 0; j < m; j++) {
        const card = keys[j] ? pictures.get(keys[j].key) : null
        const dx = cardOffset(j, m)
        for (let y = 0; y < IMAGE_GRID; y++) {
          for (let x = 0; x < IMAGE_GRID; x++, k++) {
            aNote[k] = i
            aOff.set([gauss(r), gauss(r), gauss(r)], k * 3)
            const p = ((IMAGE_GRID - 1 - y) * IMAGE_GRID + x) * 3
            if (card) aColor.set([card[p], card[p + 1], card[p + 2]], k * 3)
            else aColor.set([base.r * 0.5, base.g * 0.5, base.b * 0.5], k * 3)
            aRand.set([r(), r(), 1], k * 3)
            aPlane.set([dx + (x + r() * 0.6) / IMAGE_GRID - 0.5, (y + r() * 0.6) / IMAGE_GRID - 0.5], k * 2)
          }
        }
      }
    }
    // Photographs keep their own pixels. The soft volume and its sparse depth-writing stars
    // share one bounded transform; there are no lattice lines or flat sheet surfaces.
    const part = (card: boolean, material: ShaderMaterial, name: string) => {
      const idx: number[] = []
      for (let q = 0; q < total; q++) if ((aRand[q * 3 + 2] > 0.5) === card) idx.push(q)
      const pick = (src: Float32Array, k: number) => {
        const out = new Float32Array(idx.length * k)
        idx.forEach((q, j) => out.set(src.subarray(q * k, q * k + k), j * k))
        return out
      }
      const g = new BufferGeometry()
      g.setAttribute('aNote', new BufferAttribute(pick(aNote, 1), 1))
      g.setAttribute('aOff', new BufferAttribute(pick(aOff, 3), 3))
      g.setAttribute('aColor', new BufferAttribute(pick(aColor, 3), 3))
      g.setAttribute('aRand', new BufferAttribute(pick(aRand, 3), 3))
      g.setAttribute('aPlane', new BufferAttribute(pick(aPlane, 2), 2))
      g.setAttribute('aRole', new BufferAttribute(pick(aRole, 1), 1))
      g.setAttribute('position', new BufferAttribute(new Float32Array(idx.length * 3), 3))
      const p = new Points(g, material)
      p.frustumCulled = false
      p.layers.set(LAYER.SOLID)
      p.raycast = () => {}
      p.name = name
      return p
    }
    const clouds = part(false, cloudMat, 'field-clouds')
    const cards = part(true, cardMat, 'field-cards')
    const glow = new Points(clouds.geometry, glowMat)
    glow.frustumCulled = false
    glow.layers.set(LAYER.SOLID)
    glow.raycast = () => {}
    glow.name = 'field-nebula-glow'

    const bondGeometry = new BufferGeometry()
    for (const [name, values, itemSize] of [
      ['aNote', bondNotes, 1], ['aOff', bondOffsets, 3], ['aColor', bondColors, 3],
      ['aPhase', bondPhases, 1], ['aRole', bondRoles, 1],
    ] as const) bondGeometry.setAttribute(name, new BufferAttribute(Float32Array.from(values), itemSize))
    bondGeometry.setAttribute('position', new BufferAttribute(new Float32Array(bondNotes.length * 3), 3))
    const bonds = new LineSegments(bondGeometry, bondMat)
    bonds.frustumCulled = false
    bonds.layers.set(LAYER.SOLID)
    bonds.raycast = () => {}
    bonds.name = 'record-molecular-bonds'

    const links = buildTypedLinks(new Map(frame.records.map((r) => [r.id, r])))
    const per = currentGrainsPerLink(links.length)
    const m = links.length * per
    const aEnds = new Float32Array(m * 2)
    const aFlow = new Float32Array(m * 2)
    const aCol = new Float32Array(m * 3)
    links.forEach((l, li) => {
      const r = rng(hash(l.from + l.to))
      const c = new Color(LINK_STYLE[l.kind as LinkKind].color)
      for (let g = 0; g < per; g++) {
        const q = li * per + g
        aEnds.set([frame.index.get(l.from)!, frame.index.get(l.to)!], q * 2)
        aFlow.set([g / per + r() * 0.02, r()], q * 2)
        aCol.set([c.r * 0.9, c.g * 0.9, c.b * 0.9], q * 3)
      }
    })
    const lg = new BufferGeometry()
    lg.setAttribute('aEnds', new BufferAttribute(aEnds, 2))
    lg.setAttribute('aFlow', new BufferAttribute(aFlow, 2))
    lg.setAttribute('aColor', new BufferAttribute(aCol, 3))
    lg.setAttribute('position', new BufferAttribute(new Float32Array(m * 3), 3))
    const currents = new Points(lg, currentMat)
    currents.frustumCulled = false
    currents.layers.set(LAYER.SOLID)
    currents.raycast = () => {}
    currents.name = 'field-currents'
    const currentGlow = new Points(lg, currentGlowMat)
    currentGlow.frustumCulled = false
    currentGlow.layers.set(LAYER.SOLID)
    currentGlow.raycast = () => {}
    currentGlow.name = 'field-current-glow'
    return { clouds, cards, bonds, currents, glow, currentGlow }
  }, [structure, pictureVersion, cloudMat, cardMat, bondMat, currentMat, glowMat, currentGlowMat])
  useEffect(
    () => () => {
      clouds.geometry.dispose()
      cards.geometry.dispose()
      bonds.geometry.dispose()
      currents.geometry.dispose()
    },
    [clouds, cards, bonds, currents, glow, currentGlow],
  )

  // Dev: isolate data-associated layers without manufacturing background geometry.
  useEffect(() => {
    const layers = { clouds, cards, bonds, currents, glow, currentGlow }
    registerDevApi('fieldLayers', (want: Partial<Record<keyof typeof layers, boolean>> = {}) => {
      for (const [k, v] of Object.entries(want)) if (k in layers) layers[k as keyof typeof layers].visible = v
      return Object.fromEntries(Object.entries(layers).map(([k, p]) => [k, p.visible]))
    })
    registerDevApi('fieldMolecules', () => ({
      packets: getFieldFrame().ids.length,
      molecules: clouds.geometry.getAttribute('aNote').count,
      nuclei: getFieldFrame().born.reduce((sum, born) => sum + born, 0),
      currentMolecules: currents.geometry.getAttribute('aEnds').count,
      localBonds: bonds.geometry.getAttribute('aNote').count / 2,
    }))
  }, [clouds, cards, bonds, currents, glow, currentGlow])

  const seen = useRef({ version: -1, structure: -1 })
  // Fast Refresh may replace GPU textures while preserving the evaluated frame and refs.
  useEffect(() => {
    seen.current = { version: -1, structure: -1 }
  }, [notesTex])
  // What is on screen eases toward what time says (attention re-condensing, a sudden scrub),
  // without changing what time says: the runtime's frame stays a pure function of the playhead.
  const shown = useRef({ sigma: new Float32Array(0), order: new Float32Array(0), hl: new Float32Array(0) })
  const look = useMemo(() => new Vector3(), [])
  const texels = useRef(new Float32Array(0))
  const highlighted = useRef(new Set<number>())

  useFrame((state, dt) => {
    const frame = getFieldFrame()
    if (frame.structure !== structure) setStructure(frame.structure)
    const cam = state.camera
    if (sceneMotionEnabled()) flowTime.current += Math.min(dt, 0.1)
    common.uTime.value = flowTime.current
    common.uDpr.value = dpr
    common.uPixel.value = (size.height * dpr) / (2 * Math.tan(((cam as { fov?: number }).fov ?? 50) * (Math.PI / 360)))
    const s = seen.current

    // Clouds: ease sigma, order and highlight toward their targets.
    const n = frame.ids.length
    const sh = shown.current
    if (frame.structure !== s.structure || sh.sigma.length !== n) {
      sh.sigma = Float32Array.from(frame.sigma)
      sh.order = Float32Array.from(frame.order)
      sh.hl = new Float32Array(n)
    }
    const { selectedId, hoveredId } = useApp.getState()
    const sel = selectedId !== null ? frame.index.get(selectedId) : undefined
    const linked = highlighted.current
    linked.clear()
    if (sel !== undefined) {
      for (const l of frame.records[sel].links) {
        const j = frame.index.get(l.targetId)
        if (j !== undefined) linked.add(j)
      }
      frame.records.forEach((r, j) => r.links.some((l) => l.targetId === selectedId) && linked.add(j))
    }
    const k = 1 - Math.exp(-EASE * Math.min(dt, 0.1))
    const rows = Math.max(1, n)
    if (texels.current.length !== rows * 12) texels.current = new Float32Array(rows * 12)
    const data = texels.current
    data.fill(0)
    for (let i = 0; i < n; i++) {
      // A scrub that crosses a birth or death shows at once; within a life, ease.
      const jump = frame.born[i] === 0 || frame.condense[i] < 1
      sh.sigma[i] = jump ? frame.sigma[i] : sh.sigma[i] + (frame.sigma[i] - sh.sigma[i]) * k
      sh.order[i] = jump ? frame.order[i] : sh.order[i] + (frame.order[i] - sh.order[i]) * k
      const hlTarget = i === sel ? 1 : frame.ids[i] === hoveredId ? 0.7 : linked.has(i) ? 0.35 : 0
      sh.hl[i] += (hlTarget - sh.hl[i]) * Math.min(1, k * 2)
      data.set([frame.centers[i * 3], frame.centers[i * 3 + 1], frame.centers[i * 3 + 2], sh.sigma[i]], i * 4)
      data.set([sh.order[i], frame.born[i], sh.hl[i], frame.condense[i]], (rows + i) * 4)
      const rec = frame.records[i]
      if (rec.splat) {
        look.set(frame.centers[i * 3], frame.centers[i * 3 + 1], frame.centers[i * 3 + 2])
        data[(2 * rows + i) * 4] = sceneReveal(rec, look.distanceTo(cam.position))
      }
    }
    notesTex.image = { data, width: rows, height: 3 } as unknown as typeof notesTex.image
    notesTex.needsUpdate = true
    common.uN.value = rows
    s.version = frame.version
    s.structure = frame.structure
  }, -1)

  return (
    <group name="field">
      <primitive object={clouds} />
      <primitive object={bonds} />
      <primitive object={cards} />
      <primitive object={currents} />
      <primitive object={glow} />
      <primitive object={currentGlow} />
      <FieldVideos notes={common} />
    </group>
  )
}
