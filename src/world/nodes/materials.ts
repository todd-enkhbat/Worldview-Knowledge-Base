import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  type Material,
  type Texture,
} from 'three'

// Node materials. Created once per NodeLayer mount and disposed with it. Colours are the
// index.css tokens; anything meant to bloom is an HDR colour (> 1) on a toneMapped:false
// material. Per-instance glow (and its hover / selection boost) rides on instanceColor.

export const COLORS = {
  void: new Color('#0b0b0c'),
  concrete: new Color('#8d8a84'),
  bone: new Color('#d6d3cc'),
  brass: new Color('#c9973f'),
  ember: new Color('#e8b04a'),
  signal: new Color('#ff4a1c'),
  glass: new Color('#9fd3e6'),
} as const

/** Glow gains (multiples of the accent colour) shared by every archetype. */
export const GAIN = { hover: 1.8, select: 4.5, emphasis: 1.4 } as const

/**
 * Emissive accents brighten with view distance (×1 inside `near`, ×(1 + gain) beyond `far`):
 * thin edges and seams cover fewer pixels the farther they are, and the extra HDR keeps them
 * over the bloom threshold, so a node still reads as a lit object from a wide shot.
 */
export const FAR_GLOW = { near: 40, far: 180, gain: 1.6 } as const

const FAR_GLOW_GLSL = /* glsl */ `(1.0 + ${FAR_GLOW.gain.toFixed(3)} * smoothstep(${FAR_GLOW.near.toFixed(1)}, ${FAR_GLOW.far.toFixed(1)}, vFarDist))`

/** MeshBasic glow whose HDR instance colour gains FAR_GLOW with view distance. */
function glowMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color: '#ffffff', toneMapped: false })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFarDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFarDist = -mvPosition.z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFarDist;')
      .replace('#include <opaque_fragment>', `outgoingLight *= ${FAR_GLOW_GLSL};\n#include <opaque_fragment>`)
  }
  m.customProgramCacheKey = () => 'node-glow-far'
  return m
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Board-formed concrete: horizontal timber boards with grain streaks, seams, tie holes and
 * pores, painted once into a canvas. Deterministic (seeded) so every slab matches.
 */
export function boardFormedConcreteTexture(size = 512): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const rnd = mulberry32(0x0b0a1d)
  g.fillStyle = '#8d8a84'
  g.fillRect(0, 0, size, size)
  const boards = 7
  const bh = size / boards
  for (let b = 0; b < boards; b++) {
    const y0 = b * bh
    const tone = (rnd() - 0.5) * 0.16
    g.fillStyle = tone > 0 ? `rgba(220,214,204,${tone})` : `rgba(28,26,24,${-tone})`
    g.fillRect(0, y0, size, bh)
    for (let k = 0; k < 46; k++) {
      const y = y0 + rnd() * bh
      const dark = rnd() < 0.6
      g.strokeStyle = dark ? `rgba(38,36,33,${0.05 + rnd() * 0.09})` : `rgba(214,208,198,${0.04 + rnd() * 0.07})`
      g.lineWidth = 0.6 + rnd() * 1.8
      g.beginPath()
      let x = -10
      let yy = y
      g.moveTo(x, yy)
      while (x < size + 10) {
        x += 14 + rnd() * 50
        yy += (rnd() - 0.5) * 1.6
        g.lineTo(x, yy)
      }
      g.stroke()
    }
    g.fillStyle = 'rgba(24,22,20,0.55)'
    g.fillRect(0, y0, size, 2)
    g.fillStyle = 'rgba(232,226,216,0.18)'
    g.fillRect(0, y0 + 2, size, 1)
  }
  // Snap-tie holes on a grid, offset from the seams like a real formwork panel.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      const x = size * (0.22 + 0.56 * col)
      const y = size * (0.2 + 0.3 * row)
      const r = size * 0.014
      g.fillStyle = 'rgba(200,194,184,0.35)'
      g.beginPath()
      g.arc(x, y, r * 1.6, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = 'rgba(20,19,17,0.9)'
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fill()
    }
  }
  for (let k = 0; k < 1800; k++) {
    const r = rnd() < 0.92 ? 0.6 + rnd() * 0.9 : 1.5 + rnd() * 2
    g.fillStyle = `rgba(22,21,19,${0.25 + rnd() * 0.5})`
    g.beginPath()
    g.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.anisotropy = 4
  return tex
}

/** MeshPhysicalMaterial whose facet edges glow with the per-instance colour (aBary). */
function crystalMaterial(): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({
    color: '#07080b',
    metalness: 0.15,
    roughness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    ior: 1.6,
    specularIntensity: 1,
    envMapIntensity: 1.6,
    flatShading: true,
  })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aBary;\nvarying vec3 vBary;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBary = aBary;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBary;')
      // instanceColor is the glow colour here, not a diffuse tint.
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float eb = min(min(vBary.x, vBary.y), vBary.z);
          float hair = 1.0 - smoothstep(0.0, fwidth(eb) * 1.75, eb);
          float halo = exp(-eb * 24.0) * 0.4;
          // From afar the facets fill with a faint ember core, so the crystal reads as a lit
          // gem rather than a black speck with sub-pixel edges.
          float farK = smoothstep(${FAR_GLOW.near.toFixed(1)}, ${FAR_GLOW.far.toFixed(1)}, length(vViewPosition));
          // USE_INSTANCING_COLOR is a vertex-stage define; the fragment stage only gets
          // USE_COLOR (and vColor) from it.
          #if defined( USE_COLOR )
            totalEmissiveRadiance += vColor.rgb * ((hair + halo) * (1.0 + ${FAR_GLOW.gain.toFixed(3)} * farK) + 0.04 + 0.3 * farK);
          #endif
        }`,
      )
  }
  m.customProgramCacheKey = () => 'node-crystal-edge-far'
  return m
}

/**
 * Obsidian with hairline ember edges (from the box UVs, glow colour on instanceColor): a
 * black slab against the void has no silhouette, so its outline is drawn in light, the same
 * language as the crystal edges.
 */
function obsidianMaterial(): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({
    color: '#040405',
    metalness: 0.2,
    roughness: 0.03,
    clearcoat: 1,
    clearcoatRoughness: 0.015,
    specularIntensity: 1,
    envMapIntensity: 2.4,
  })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vEdgeUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdgeUv = uv;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vEdgeUv;')
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec2 q = min(vEdgeUv, 1.0 - vEdgeUv);
          float e = min(q.x, q.y);
          float hair = 1.0 - smoothstep(0.0, fwidth(e) * 1.5, e);
          float farK = smoothstep(${FAR_GLOW.near.toFixed(1)}, ${FAR_GLOW.far.toFixed(1)}, length(vViewPosition));
          #if defined( USE_COLOR )
            totalEmissiveRadiance += vColor.rgb * (hair * (1.0 + ${FAR_GLOW.gain.toFixed(3)} * farK) + 0.05 * farK);
          #endif
        }`,
      )
  }
  m.customProgramCacheKey = () => 'node-obsidian-edge'
  return m
}

const instancedVertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec2 vUv;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 mv = modelViewMatrix * p;
    vN = normalize(normalMatrix * n);
    vV = normalize(-mv.xyz);
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`

/** Additive fresnel front shell: glass that shows only at grazing angles and face edges. */
function fresnelShellMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    name: 'node-fresnel-shell',
    uniforms: {
      uColor: { value: COLORS.glass.clone().multiplyScalar(0.55) },
      uEdge: { value: COLORS.bone.clone().multiplyScalar(0.5) },
    },
    vertexShader: instancedVertex,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uEdge;
      varying vec3 vN;
      varying vec3 vV;
      varying vec2 vUv;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        vec2 d = abs(vUv - 0.5) * 2.0;
        float edge = smoothstep(0.955, 1.0, max(d.x, d.y));
        gl_FragColor = vec4(uColor * (0.04 + f) + uEdge * edge, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: FrontSide,
  })
}

/** Faint flow lines streaming along the lens axis. */
function flowConeMaterial(time: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    name: 'node-lens-flow',
    uniforms: { uTime: time, uColor: { value: COLORS.ember.clone().multiplyScalar(0.9) } },
    vertexShader: instancedVertex,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float s = 1.0 - vUv.y; // 0 at the lens, 1 at the far rim
        float m = abs(fract(vUv.x * 20.0) - 0.5) * 2.0;
        float meridian = smoothstep(0.82, 1.0, m);
        float pulse = pow(fract(s * 2.5 - uTime * 0.35), 8.0);
        float fade = pow(1.0 - s, 1.6) * smoothstep(0.0, 0.06, s);
        gl_FragColor = vec4(uColor * (meridian * (0.25 + pulse * 1.6)) * fade * 0.5, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
}

export interface NodeMaterials {
  crystal: MeshPhysicalMaterial
  obsidian: MeshPhysicalMaterial
  brass: MeshStandardMaterial
  chrome: MeshStandardMaterial
  darkGlass: MeshPhysicalMaterial
  blackSteel: MeshStandardMaterial
  concrete: MeshStandardMaterial
  /** White MeshBasic; instanceColor carries the HDR glow colour. */
  glow: MeshBasicMaterial
  ghost: MeshBasicMaterial
  backShell: MeshStandardMaterial
  frontShell: ShaderMaterial
  depthProxy: MeshBasicMaterial
  flowCone: ShaderMaterial
  demonField: MeshBasicMaterial
  selectRing: MeshBasicMaterial
  hoverRing: MeshBasicMaterial
}

export interface NodeMaterialKit {
  mat: NodeMaterials
  /** Shared clock for animated shaders; NodeLayer advances it. */
  time: { value: number }
  dispose(): void
}

export function createNodeMaterials(): NodeMaterialKit {
  const time = { value: 0 }
  const concreteTex = boardFormedConcreteTexture()
  const mat: NodeMaterials = {
    crystal: crystalMaterial(),
    obsidian: obsidianMaterial(),
    brass: new MeshStandardMaterial({ color: COLORS.brass, metalness: 1, roughness: 0.3, envMapIntensity: 1.3 }),
    chrome: new MeshStandardMaterial({ color: '#e9eaec', metalness: 1, roughness: 0.07, envMapIntensity: 1.6 }),
    darkGlass: new MeshPhysicalMaterial({
      color: '#080a0d',
      metalness: 0,
      roughness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.6,
    }),
    blackSteel: new MeshStandardMaterial({ color: '#17150f', metalness: 0.85, roughness: 0.42 }),
    concrete: new MeshStandardMaterial({
      map: concreteTex,
      bumpMap: concreteTex,
      bumpScale: 1.2,
      roughness: 0.93,
      metalness: 0,
      envMapIntensity: 0.6,
    }),
    glow: glowMaterial(),
    ghost: new MeshBasicMaterial({
      color: COLORS.glass.clone().multiplyScalar(0.6),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    }),
    backShell: new MeshStandardMaterial({
      color: '#05070a',
      metalness: 0,
      roughness: 0.12,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: BackSide,
      envMapIntensity: 0.7,
    }),
    frontShell: fresnelShellMaterial(),
    // transparent: sorted into the transparent list, so renderOrder 100 puts it after the
    // shells and splats it must not cull.
    depthProxy: new MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: BackSide, transparent: true }),
    flowCone: flowConeMaterial(time),
    demonField: new MeshBasicMaterial({
      color: COLORS.ember.clone().multiplyScalar(0.5),
      wireframe: true,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    }),
    selectRing: new MeshBasicMaterial({ color: COLORS.signal.clone().multiplyScalar(4), toneMapped: false }),
    hoverRing: new MeshBasicMaterial({ color: COLORS.ember.clone().multiplyScalar(1.6), toneMapped: false }),
  }
  mat.backShell.name = 'node-back-shell'
  mat.depthProxy.name = 'node-depth-proxy'
  return {
    mat,
    time,
    dispose() {
      for (const m of Object.values(mat) as Material[]) m.dispose()
      concreteTex.dispose()
    },
  }
}
