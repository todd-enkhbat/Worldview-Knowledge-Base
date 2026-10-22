import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  NearestFilter,
  Points,
  RGBAFormat,
  RedFormat,
  ShaderMaterial,
} from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { getStore, isRepoReady } from '../../data/repo.ts'
import type { Archetype, LinkKind } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { LINK_STYLE, buildTypedLinks } from '../links/style.ts'
import { getFieldFrame, type FieldFrame } from './runtime.ts'
import { RIPPLE_Y } from './state.ts'

// The particle world (milestone 2). Three point layers, all GPU-animated from small textures
// the runtime fills each frame:
//   land      a jittered grid of grains lifted by the heightfield, swept by birth ripples
//   clouds    each note as a cloud of grains (a photo note's grains are its photo)
//   currents  grains flowing along links, coloured by link kind
// Shape comes from the playhead (runtime.ts, a pure function of time); a slow wall-clock
// shimmer keeps the paused world alive without moving anything that time decides.

const LAND_GRID = 300
const MAX_GRAINS = 260_000
const IMAGE_GRID = 56
const CURRENT_GRAINS = 40
const MAX_RIPPLES = 16

const ARCHETYPE_COLOR: Record<Archetype, string> = {
  idea: '#9fd3e6',
  entity: '#e9e4d8',
  lens: '#d9a54a',
  document: '#bdb8ad',
  memory: '#f0b85a',
  demon: '#ff5a2c',
}

// ─── shared GLSL ─────────────────────────────────────────────────────────────────────

const NOTE_FETCH = /* glsl */ `
uniform sampler2D uNotes;
uniform float uN;
vec4 noteA(float i) { return texture2D(uNotes, vec2((i + 0.5) / uN, 0.25)); }
vec4 noteB(float i) { return texture2D(uNotes, vec2((i + 0.5) / uN, 0.75)); }
`

const SOFT_DOT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.2) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`

/** Land grains are small solid dots that write depth, so post fog sees the land, not the sky. */
const SOLID_DOT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 0.8 || vAlpha < 0.05) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`

// ─── land ────────────────────────────────────────────────────────────────────────────

const LAND_VERT = /* glsl */ `
uniform sampler2D uHeight;
uniform float uRes;
uniform vec4 uExtent; // x0, z0, size, unused
uniform float uTime;
uniform float uPixel;
uniform vec4 uRipples[${MAX_RIPPLES}]; // x, z, age (years), amp
uniform float uRippleSpeed;
attribute vec2 aUV;
attribute vec2 aRand;
varying vec3 vColor;
varying float vAlpha;

float heightAt(vec2 uv) {
  vec2 f = uv * (uRes - 1.0);
  vec2 i = floor(f);
  vec2 t = f - i;
  float a = texture2D(uHeight, (i + vec2(0.5, 0.5)) / uRes).r;
  float b = texture2D(uHeight, (i + vec2(1.5, 0.5)) / uRes).r;
  float c = texture2D(uHeight, (i + vec2(0.5, 1.5)) / uRes).r;
  float d = texture2D(uHeight, (i + vec2(1.5, 1.5)) / uRes).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

void main() {
  vec2 xz = uExtent.xy + aUV * uExtent.z;
  float h = heightAt(clamp(aUV, 0.0, 1.0));
  // A slow ambient swell, then every recent birth's wave front.
  float swell = 0.45 * sin(0.07 * xz.x + 0.35 * uTime) * cos(0.06 * xz.y - 0.27 * uTime);
  float crest = 0.0;
  for (int k = 0; k < ${MAX_RIPPLES}; k++) {
    vec4 r = uRipples[k];
    if (r.w <= 0.0) continue;
    float dist = length(xz - r.xy);
    float front = r.z * uRippleSpeed;
    float fade = 1.0 - r.z / ${RIPPLE_Y.toFixed(2)};
    crest += r.w * fade * exp(-pow(dist - front, 2.0) / 40.0);
  }
  vec3 p = vec3(xz.x, h + swell + crest * 1.6 + aRand.x * 0.25, xz.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((0.16 + 0.16 * aRand.y) * uPixel / -mv.z, 1.0, 7.0);
  float lift = smoothstep(0.0, 14.0, h);
  vec3 low = vec3(0.05, 0.06, 0.085);
  vec3 mid = vec3(0.24, 0.23, 0.22);
  vec3 high = vec3(0.95, 0.66, 0.33);
  // Faint survey contours every 2 u of height, as in the classic world's ranges.
  float contour = smoothstep(0.92, 1.0, abs(fract(h * 0.5) * 2.0 - 1.0)) * smoothstep(0.3, 2.0, h);
  vColor = mix(mix(low, mid, smoothstep(0.0, 0.5, lift)), high, smoothstep(0.5, 1.0, lift)) * (0.75 + 0.5 * aRand.y)
    + vec3(0.9, 0.62, 0.3) * contour * 0.35
    + vec3(1.0, 0.8, 0.5) * min(crest, 1.0) * 0.9;
  vec2 c = aUV * 2.0 - 1.0;
  float edge = 1.0 - smoothstep(0.55, 1.0, length(c));
  vAlpha = edge * (0.55 + 0.4 * lift + 0.4 * min(crest, 1.0));
}
`

// ─── clouds ──────────────────────────────────────────────────────────────────────────

const CLOUD_VERT = /* glsl */ `
${NOTE_FETCH}
uniform float uTime;
uniform float uPixel;
attribute float aNote;
attribute vec3 aOff;
attribute vec3 aColor;
attribute vec3 aRand;   // phase, size, plane (1 = part of an image card)
attribute vec2 aPlane;  // image-card position in [-0.5, 0.5]²
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 a = noteA(aNote);
  vec4 b = noteB(aNote);
  if (b.y < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float order = b.x;
  float hl = b.z;
  float cond = b.w;
  float sigma = a.w;
  float ph = aRand.x * 6.2831;
  vec3 drift = vec3(sin(uTime * 0.37 + ph), 0.6 * sin(uTime * 0.29 + ph * 1.7), cos(uTime * 0.33 + ph * 1.3));
  vec4 mv;
  if (aRand.z > 0.5) {
    // An image note: its grains hold the picture, facing you, dissolving as order falls.
    vec4 c = modelViewMatrix * vec4(a.xyz + vec3(0.0, 1.5, 0.0), 1.0);
    float card = 7.0 * (0.6 + 0.4 * cond);
    vec3 scatter = aOff * sigma * (0.06 + 0.9 * (1.0 - order) * (1.0 - order)) + drift * 0.12;
    mv = c + vec4(aPlane.x * card, aPlane.y * card, 0.0, 0.0) + vec4(scatter * (2.0 - cond), 0.0);
  } else {
    vec3 p = a.xyz + aOff * sigma + drift * sigma * (0.07 + 0.25 * (1.0 - order));
    mv = modelViewMatrix * vec4(p, 1.0);
  }
  gl_Position = projectionMatrix * mv;
  float size = (aRand.z > 0.5 ? 0.5 : 0.36 + 0.5 * aRand.y) * (1.0 + 0.5 * hl);
  gl_PointSize = clamp(size * uPixel / -mv.z, 1.0, 22.0);
  vColor = aColor * (aRand.z > 0.5 ? 1.0 : 1.3) * (1.0 + 1.2 * hl);
  vAlpha = (aRand.z > 0.5 ? 0.9 : 0.28 + 0.4 * order) * cond;
}
`

// ─── currents ────────────────────────────────────────────────────────────────────────

const CURRENT_VERT = /* glsl */ `
${NOTE_FETCH}
uniform float uTime;
uniform float uPixel;
attribute vec2 aEnds;   // from, to note indices
attribute vec2 aFlow;   // phase, speed jitter
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 A = noteA(aEnds.x);
  vec4 B = noteA(aEnds.y);
  if (noteB(aEnds.x).y < 0.5 || noteB(aEnds.y).y < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float u = fract(aFlow.x + uTime * (0.05 + 0.04 * aFlow.y));
  float len = distance(A.xyz, B.xyz);
  vec3 mid = mix(A.xyz, B.xyz, 0.5) + vec3(0.0, 2.0 + len * 0.22, 0.0);
  vec3 p = mix(mix(A.xyz, mid, u), mix(mid, B.xyz, u), u);
  p += vec3(sin(aFlow.x * 40.0 + uTime), cos(aFlow.x * 31.0 + uTime * 0.8), sin(aFlow.x * 23.0)) * 0.35;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.5 * uPixel / -mv.z, 1.0, 8.0);
  vColor = aColor * 1.8;
  float hl = max(noteB(aEnds.x).z, noteB(aEnds.y).z);
  vAlpha = sin(3.14159 * u) * (0.45 + 0.5 * hl);
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

/** An image note's picture as IMAGE_GRID² linear-ish RGB, from its thumbnail. */
const pictures = new Map<string, Float32Array | null>()

async function loadPicture(blobId: string): Promise<Float32Array | null> {
  if (!isRepoReady() || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null
  try {
    const blob = await getStore().getBlob(blobId)
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
  image: boolean
}

function grainsFor(frame: FieldFrame, i: number): Budget {
  const r = frame.records[i]
  const mass = r.thermo?.mass ?? 1
  const extra = Math.min(r.attachments.length + (r.embeds?.length ?? 0), 4)
  return { cloud: Math.round(420 + 300 * mass + 120 * extra + 40 * Math.min(r.contentMd.length / 400, 8)), image: r.attachments.some((a) => a.kind === 'image') }
}

// ─── the layer ───────────────────────────────────────────────────────────────────────

export function FieldLayer() {
  const nodes = useWorld((s) => s.nodes)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const [structure, setStructure] = useState(0)
  const [pictureVersion, setPictureVersion] = useState(0)

  const notesTex = useMemo(() => {
    const t = new DataTexture(new Float32Array(8), 1, 2, RGBAFormat, FloatType)
    t.magFilter = NearestFilter
    t.minFilter = NearestFilter
    t.needsUpdate = true
    return t
  }, [])
  const heightTex = useMemo(() => {
    const t = new DataTexture(new Float32Array(4), 2, 2, RedFormat, FloatType)
    t.magFilter = NearestFilter
    t.minFilter = NearestFilter
    t.needsUpdate = true
    return t
  }, [])
  useEffect(
    () => () => {
      notesTex.dispose()
      heightTex.dispose()
    },
    [notesTex, heightTex],
  )

  const common = useMemo(() => ({ uNotes: { value: notesTex }, uN: { value: 1 }, uTime: { value: 0 }, uPixel: { value: 600 } }), [notesTex])

  const landMat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: LAND_VERT,
        fragmentShader: SOLID_DOT,
        uniforms: {
          uHeight: { value: heightTex },
          uRes: { value: 2 },
          uExtent: { value: [-50, -50, 100, 0] },
          uTime: common.uTime,
          uPixel: common.uPixel,
          uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => [0, 0, 0, 0]).flat() },
          uRippleSpeed: { value: 70 },
        },
        transparent: false,
        depthWrite: true,
      }),
    [heightTex, common],
  )
  const cloudMat = useMemo(
    () => new ShaderMaterial({ vertexShader: CLOUD_VERT, fragmentShader: SOFT_DOT, uniforms: common, transparent: true, depthWrite: false, blending: AdditiveBlending }),
    [common],
  )
  const currentMat = useMemo(
    () => new ShaderMaterial({ vertexShader: CURRENT_VERT, fragmentShader: SOFT_DOT, uniforms: common, transparent: true, depthWrite: false, blending: AdditiveBlending }),
    [common],
  )
  useEffect(
    () => () => {
      landMat.dispose()
      cloudMat.dispose()
      currentMat.dispose()
    },
    [landMat, cloudMat, currentMat],
  )

  // Land: a jittered grid, built once.
  const land = useMemo(() => {
    const n = LAND_GRID * LAND_GRID
    const uv = new Float32Array(n * 2)
    const rnd = new Float32Array(n * 2)
    const r = rng(7)
    for (let j = 0; j < LAND_GRID; j++) {
      for (let i = 0; i < LAND_GRID; i++) {
        const k = j * LAND_GRID + i
        uv[k * 2] = (i + r()) / LAND_GRID
        uv[k * 2 + 1] = (j + r()) / LAND_GRID
        rnd[k * 2] = r()
        rnd[k * 2 + 1] = r()
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('aUV', new BufferAttribute(uv, 2))
    g.setAttribute('aRand', new BufferAttribute(rnd, 2))
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))
    const p = new Points(g, landMat)
    p.frustumCulled = false
    p.layers.set(LAYER.SOLID)
    p.raycast = () => {}
    p.name = 'field-land'
    return p
  }, [landMat])
  useEffect(() => () => land.geometry.dispose(), [land])

  // Pictures for image notes (async; the clouds rebuild when one arrives).
  useEffect(() => {
    let live = true
    for (const r of nodes.values()) {
      const img = r.attachments.find((a) => a.kind === 'image')
      if (!img || pictures.has(img.blobId)) continue
      pictures.set(img.blobId, null)
      void loadPicture(img.thumbBlobId ?? img.blobId).then((pic) => {
        pictures.set(img.blobId, pic)
        if (live && pic) setPictureVersion((v) => v + 1)
      })
    }
    return () => {
      live = false
    }
  }, [nodes])

  // Clouds and currents rebuild when the set of notes or the layout changes.
  const { clouds, currents } = useMemo(() => {
    void structure
    void pictureVersion
    const frame = getFieldFrame()
    const n = frame.ids.length
    const budgets = frame.ids.map((_, i) => grainsFor(frame, i))
    const planned = budgets.reduce((s, b) => s + b.cloud + (b.image ? IMAGE_GRID * IMAGE_GRID : 0), 0)
    const scale = Math.min(1, MAX_GRAINS / Math.max(1, planned))
    const total = budgets.reduce((s, b) => s + Math.round(b.cloud * scale) + (b.image ? IMAGE_GRID * IMAGE_GRID : 0), 0)
    const aNote = new Float32Array(total)
    const aOff = new Float32Array(total * 3)
    const aColor = new Float32Array(total * 3)
    const aRand = new Float32Array(total * 3)
    const aPlane = new Float32Array(total * 2)
    const col = new Color()
    let k = 0
    for (let i = 0; i < n; i++) {
      const rec = frame.records[i]
      const r = rng(hash(rec.id))
      const base = new Color(ARCHETYPE_COLOR[rec.archetype]).convertSRGBToLinear()
      const img = rec.attachments.find((a) => a.kind === 'image')
      const pic = img ? pictures.get(img.blobId) : null
      const count = Math.round(budgets[i].cloud * scale)
      for (let c = 0; c < count; c++, k++) {
        aNote[k] = i
        // A soft ball, slightly flattened: the grains of an idea hover over its land.
        aOff[k * 3] = gauss(r)
        aOff[k * 3 + 1] = gauss(r) * 0.65
        aOff[k * 3 + 2] = gauss(r)
        if (pic && r() < 0.6) {
          const p = Math.floor(r() * IMAGE_GRID * IMAGE_GRID) * 3
          col.setRGB(pic[p], pic[p + 1], pic[p + 2])
        } else {
          col.copy(base).multiplyScalar(0.7 + 0.5 * r())
        }
        aColor.set([col.r, col.g, col.b], k * 3)
        aRand.set([r(), r(), 0], k * 3)
      }
      if (budgets[i].image) {
        for (let y = 0; y < IMAGE_GRID; y++) {
          for (let x = 0; x < IMAGE_GRID; x++, k++) {
            aNote[k] = i
            aOff.set([gauss(r), gauss(r), gauss(r)], k * 3)
            const p = ((IMAGE_GRID - 1 - y) * IMAGE_GRID + x) * 3
            if (pic) aColor.set([pic[p], pic[p + 1], pic[p + 2]], k * 3)
            else aColor.set([base.r * 0.5, base.g * 0.5, base.b * 0.5], k * 3)
            aRand.set([r(), r(), 1], k * 3)
            aPlane.set([(x + r() * 0.6) / IMAGE_GRID - 0.5, (y + r() * 0.6) / IMAGE_GRID - 0.5], k * 2)
          }
        }
      }
    }
    const cg = new BufferGeometry()
    cg.setAttribute('aNote', new BufferAttribute(aNote, 1))
    cg.setAttribute('aOff', new BufferAttribute(aOff, 3))
    cg.setAttribute('aColor', new BufferAttribute(aColor, 3))
    cg.setAttribute('aRand', new BufferAttribute(aRand, 3))
    cg.setAttribute('aPlane', new BufferAttribute(aPlane, 2))
    cg.setAttribute('position', new BufferAttribute(new Float32Array(total * 3), 3))
    const clouds = new Points(cg, cloudMat)
    clouds.frustumCulled = false
    clouds.layers.set(LAYER.SOLID)
    clouds.raycast = () => {}
    clouds.name = 'field-clouds'

    const links = buildTypedLinks(new Map(frame.records.map((r) => [r.id, r])))
    const m = links.length * CURRENT_GRAINS
    const aEnds = new Float32Array(m * 2)
    const aFlow = new Float32Array(m * 2)
    const aCol = new Float32Array(m * 3)
    links.forEach((l, li) => {
      const r = rng(hash(l.from + l.to))
      const c = new Color(LINK_STYLE[l.kind as LinkKind].color).convertSRGBToLinear()
      for (let g = 0; g < CURRENT_GRAINS; g++) {
        const q = li * CURRENT_GRAINS + g
        aEnds.set([frame.index.get(l.from)!, frame.index.get(l.to)!], q * 2)
        aFlow.set([g / CURRENT_GRAINS + r() * 0.02, r()], q * 2)
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
    return { clouds, currents }
  }, [structure, pictureVersion, cloudMat, currentMat])
  useEffect(
    () => () => {
      clouds.geometry.dispose()
      currents.geometry.dispose()
    },
    [clouds, currents],
  )

  const seen = useRef({ version: -1, structure: -1, sel: null as string | null, hov: null as string | null })

  useFrame((state) => {
    const frame = getFieldFrame()
    if (frame.structure !== structure) setStructure(frame.structure)
    common.uTime.value = state.clock.elapsedTime
    common.uPixel.value = (size.height * dpr) / (2 * Math.tan(((state.camera as { fov?: number }).fov ?? 50) * (Math.PI / 360)))
    const { selectedId, hoveredId } = useApp.getState()
    const s = seen.current
    if (frame.version === s.version && selectedId === s.sel && hoveredId === s.hov) return
    s.version = frame.version
    s.sel = selectedId
    s.hov = hoveredId

    // Note texture: row 0 = centre, sigma; row 1 = order, born, highlight, condense.
    const n = Math.max(1, frame.ids.length)
    const data = new Float32Array(n * 2 * 4)
    const linked = new Set<string>()
    const sel = selectedId ? frame.records[frame.index.get(selectedId) ?? -1] : undefined
    if (sel) for (const l of sel.links) linked.add(l.targetId)
    for (const r of frame.records) if (selectedId && r.links.some((l) => l.targetId === selectedId)) linked.add(r.id)
    for (let i = 0; i < frame.ids.length; i++) {
      const id = frame.ids[i]
      data.set([frame.centers[i * 3], frame.centers[i * 3 + 1], frame.centers[i * 3 + 2], frame.sigma[i]], i * 4)
      const hl = id === selectedId ? 1 : id === hoveredId ? 0.7 : linked.has(id) ? 0.35 : 0
      data.set([frame.order[i], frame.born[i], hl, frame.condense[i]], (n + i) * 4)
    }
    notesTex.image = { data, width: n, height: 2 } as unknown as typeof notesTex.image
    notesTex.needsUpdate = true
    common.uN.value = n

    const hf = frame.heightfield
    heightTex.image = { data: hf.h, width: hf.res, height: hf.res } as unknown as typeof heightTex.image
    heightTex.needsUpdate = true
    landMat.uniforms.uRes.value = hf.res
    landMat.uniforms.uExtent.value = [hf.x0, hf.z0, hf.size, 0]
    const rip = landMat.uniforms.uRipples.value as number[]
    rip.fill(0)
    frame.ripples.forEach((r, i) => rip.splice(i * 4, 4, r.x, r.z, r.age, r.amp))
  }, -1)

  return (
    <group name="field">
      <primitive object={land} />
      <primitive object={clouds} />
      <primitive object={currents} />
    </group>
  )
}
