import {
  CanvasTexture,
  Color,
  LinearSRGBColorSpace,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type WebGLProgramParametersWithUniforms,
} from 'three'

// Procedural materials for the architecture. No texture downloads: concrete is a triplanar
// shader (board-formed formwork lines, staggered butt joints, tie holes, rain streaks and
// mottling) injected into MeshStandardMaterial, so it keeps PBR lighting, the PMREM
// environment and instancing. Everything is evaluated in world space, which lets one unit-box
// InstancedMesh carry slabs of any size without stretching the pattern.

export const PALETTE = {
  concrete: '#8d8a84',
  concreteDark: '#5b5852',
  // Multiplies the floor texture (whose base is already dark): final albedo ≈ #3a3835.
  floor: '#8e8b86',
  ember: '#e8b04a',
  signal: '#ff4a1c',
  brass: '#b08d57',
  steel: '#a9a8a5',
  bone: '#d9d4c7',
  void: '#030304',
} as const

/** HDR emissive colour (linear, × intensity) for toneMapped:false materials that should bloom. */
export function hdr(hex: string, intensity: number): Color {
  return new Color(hex).multiplyScalar(intensity)
}

export interface ConcreteOptions {
  color?: string
  /** Formwork board height (world units). Columns and the core use tall pour lifts instead. */
  board?: number
  /** 0–1 strength of seams, joints and tie holes. */
  seams?: number
  /** Bump amplitude in world units. */
  bump?: number
  roughness?: number
}

const CONCRETE_COMMON = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform float uBoard;
uniform float uSeams;
uniform float uBump;

float cHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float cHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float cNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash12(i), cHash12(i + vec2(1.0, 0.0)), u.x),
             mix(cHash12(i + vec2(0.0, 1.0)), cHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float cFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * cNoise(p); p = p * 2.07 + 17.13; a *= 0.5; }
  return s;
}

// Formwork face: u runs along the boards, v across them (world y on walls).
// Returns (tone multiplier, height in world units, roughness offset).
// fwV = screen-space derivative of v, taken by the caller in uniform control flow.
vec3 cBoardFace(vec2 uv, float vertical, float fwV) {
  float bh = uBoard;
  float fw = max(fwV, 1e-5) / bh;
  float aa = (1.0 - smoothstep(0.12, 0.45, fw)) * uSeams;
  float row = floor(uv.y / bh);
  float t = fract(uv.y / bh);
  float blen = bh * 14.0;
  float u2 = uv.x + cHash11(row) * blen;
  float tu = fract(u2 / blen);
  float boardTone = cHash12(vec2(row, floor(u2 / blen)));
  float sw = 0.05;
  float seam = 1.0 - smoothstep(0.0, sw, t) * smoothstep(1.0, 1.0 - sw, t);
  float jw = 0.006 / bh;
  float joint = 1.0 - smoothstep(0.0, jw, tu) * smoothstep(1.0, 1.0 - jw, tu);
  float grain = cNoise(vec2(u2 * 1.7 / bh * 0.18, uv.y * 3.0 / bh + row * 3.7));
  // Tie holes on a sparse grid, aligned to board seams.
  vec2 tg = vec2(u2 / (blen * 0.5), uv.y / (bh * 6.0));
  vec2 tf = (fract(tg) - 0.5) * vec2(blen * 0.5, bh * 6.0);
  float hole = 1.0 - smoothstep(0.022, 0.034, length(tf));
  // Weathering: vertical rain streaks on walls, broad mottling everywhere.
  float streak = cNoise(vec2(uv.x * 0.9, uv.y * 0.035)) * vertical;
  float mott = cFbm(uv * 0.11);
  float tone = (0.86 + 0.28 * mott) * (1.0 - 0.16 * smoothstep(0.55, 0.95, streak));
  tone *= 1.0 + aa * ((boardTone - 0.5) * 0.10 + (grain - 0.5) * 0.10 - seam * 0.16 - joint * 0.08 - hole * 0.45);
  float h = aa * ((grain - 0.5) * 0.0025 + boardTone * 0.0015 - seam * 0.005 - joint * 0.002 - hole * 0.012);
  return vec3(tone, h, aa * (seam * 0.06 + hole * 0.1) + (mott - 0.5) * 0.08);
}

// Trowelled top surface: aggregate speckle, float marks, saw-cut joints every 4 u.
vec3 cTopFace(vec2 p, float fwP) {
  float fw = max(fwP, 1e-5);
  float aa = (1.0 - smoothstep(0.02, 0.12, fw)) * uSeams;
  float mott = cFbm(p * 0.09);
  float trowel = cNoise(vec2(p.x * 0.6 + p.y * 0.4, p.y * 2.2 - p.x * 0.3));
  float speck = step(0.93, cHash12(floor(p * 42.0)));
  vec2 cut = abs(fract(p / 4.0 + 0.5) - 0.5) * 4.0;
  float joint = 1.0 - smoothstep(0.008, 0.02, min(cut.x, cut.y));
  float tone = (0.84 + 0.3 * mott) * (1.0 + aa * ((trowel - 0.5) * 0.08 + speck * 0.12 - joint * 0.35));
  float h = aa * ((trowel - 0.5) * 0.001 - joint * 0.004);
  return vec3(tone, h, (trowel - 0.5) * 0.12 - 0.06 + aa * joint * 0.1);
}

vec3 concreteSample(vec3 p, vec3 n) {
  // Derivatives before any branch: they are undefined in non-uniform control flow.
  vec3 fwp = fwidth(p);
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);
  vec3 acc = vec3(0.0);
  if (w.x > 0.01) acc += w.x * cBoardFace(vec2(p.z, p.y), 1.0, fwp.y);
  if (w.z > 0.01) acc += w.z * cBoardFace(vec2(p.x, p.y), 1.0, fwp.y);
  if (w.y > 0.01) acc += w.y * (n.y > 0.0 ? cTopFace(p.xz, max(fwp.x, fwp.z)) : cBoardFace(vec2(p.x, p.z), 0.0, fwp.z));
  return acc;
}
`

/** Board-formed concrete: MeshStandardMaterial + triplanar procedural detail. */
export function createConcreteMaterial(opts: ConcreteOptions = {}): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color: opts.color ?? PALETTE.concrete,
    roughness: opts.roughness ?? 0.88,
    metalness: 0,
  })
  const uniforms = {
    uBoard: { value: opts.board ?? 0.16 },
    uSeams: { value: opts.seams ?? 1 },
    uBump: { value: opts.bump ?? 1 },
  }
  mat.userData.concreteUniforms = uniforms
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 triWp = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            triWp = instanceMatrix * triWp;
          #endif
          triWp = modelMatrix * triWp;
          vTriPos = triWp.xyz;
          vTriNrm = inverseTransformDirection( transformedNormal, viewMatrix );
        }`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CONCRETE_COMMON}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 concS = concreteSample( vTriPos, normalize( vTriNrm ) );
        diffuseColor.rgb *= concS.x;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp( roughnessFactor + concS.z, 0.05, 1.0 );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // Unnormalised Mikkelsen bump: height is in world units, so the relief is
          // independent of distance and resolution.
          vec3 dpdx = dFdx( -vViewPosition );
          vec3 dpdy = dFdy( -vViewPosition );
          float dhdx = dFdx( concS.y ) * uBump;
          float dhdy = dFdy( concS.y ) * uBump;
          vec3 r1 = cross( dpdy, normal );
          vec3 r2 = cross( normal, dpdx );
          float det = dot( dpdx, r1 );
          vec3 grad = sign( det ) * ( dhdx * r1 + dhdy * r2 );
          normal = normalize( abs( det ) * normal - grad );
        }`,
      )
  }
  mat.customProgramCacheKey = () => 'wv-concrete-v1'
  return mat
}

export interface MetalOptions {
  color?: string
  roughness?: number
}

export function createMetalMaterial(opts: MetalOptions = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: opts.color ?? '#ffffff',
    metalness: 1,
    roughness: opts.roughness ?? 0.32,
    envMapIntensity: 1.1,
  })
}

/** Unlit HDR emitter. Colour comes from instanceColor (or `color`), bloom from values > 1. */
export function createEmissiveMaterial(color?: Color): MeshBasicMaterial {
  const mat = new MeshBasicMaterial({ color: color ?? new Color(1, 1, 1), toneMapped: false })
  return mat
}

// ─── floor texture ──────────────────────────────────────────────────────────────────────
// Polished dark concrete: cloudy mottle, aggregate speckle and saw-cut joints. One tile covers
// FLOOR_TILE world units; the floor repeats it. Generated once on a canvas, used as both the
// colour map (sRGB) and, from a second canvas, the roughness map (linear).

export const FLOOR_TILE = 16

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FloorTextures {
  map: CanvasTexture
  roughnessMap: CanvasTexture
  dispose(): void
}

export function createFloorTextures(size = 1024): FloorTextures {
  const make = () => {
    const c = document.createElement('canvas')
    c.width = c.height = size
    return c
  }
  const colour = make()
  const rough = make()
  const cc = colour.getContext('2d')!
  const rc = rough.getContext('2d')!
  const rand = rng(0x5eed)

  cc.fillStyle = '#6d6a65'
  cc.fillRect(0, 0, size, size)
  rc.fillStyle = 'rgb(120,120,120)'
  rc.fillRect(0, 0, size, size)

  // Cloudy mottle (wrapped so the tile is seamless).
  const blot = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, style: string) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
        g.addColorStop(0, style)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2)
      }
    }
  }
  for (let i = 0; i < 70; i++) {
    const x = rand() * size
    const y = rand() * size
    const r = size * (0.05 + rand() * 0.22)
    const dark = rand() < 0.55
    blot(cc, x, y, r, dark ? `rgba(20,18,16,${0.08 + rand() * 0.12})` : `rgba(190,184,172,${0.05 + rand() * 0.08})`)
    blot(rc, x, y, r, dark ? `rgba(60,60,60,${0.1 + rand() * 0.15})` : `rgba(200,200,200,${0.08 + rand() * 0.1})`)
  }
  // Aggregate speckle.
  for (let i = 0; i < size * 60; i++) {
    const x = rand() * size
    const y = rand() * size
    const v = rand()
    const s = rand() < 0.04 ? 2 + rand() * 3 : 1 + rand()
    cc.fillStyle = v < 0.5 ? `rgba(30,28,25,${0.15 + rand() * 0.25})` : `rgba(215,210,198,${0.1 + rand() * 0.25})`
    cc.fillRect(x, y, s, s)
  }
  // Saw-cut joints: a 4 u grid, darker and rougher.
  const cuts = FLOOR_TILE / 4
  for (let i = 0; i < cuts; i++) {
    const p = Math.round((i * size) / cuts)
    cc.fillStyle = 'rgba(12,11,10,0.85)'
    cc.fillRect(p, 0, 2, size)
    cc.fillRect(0, p, size, 2)
    rc.fillStyle = 'rgb(235,235,235)'
    rc.fillRect(p, 0, 3, size)
    rc.fillRect(0, p, size, 3)
  }

  const map = new CanvasTexture(colour)
  map.colorSpace = SRGBColorSpace
  const roughnessMap = new CanvasTexture(rough)
  roughnessMap.colorSpace = LinearSRGBColorSpace
  for (const t of [map, roughnessMap]) {
    t.wrapS = t.wrapT = RepeatWrapping
    t.anisotropy = 8
  }
  return {
    map,
    roughnessMap,
    dispose() {
      map.dispose()
      roughnessMap.dispose()
    },
  }
}
