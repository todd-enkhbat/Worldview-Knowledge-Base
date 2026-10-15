import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Points,
} from 'three'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { PALETTE } from './materials.ts'

// Void sky: a gradient dome and procedural stars that ride on the camera (infinitely far), plus
// the image-based environment: a PMREM of a dark sky with a few Lightformers so chrome, brass and
// obsidian have something to reflect.

/** Pins an object to the rendering camera at a fraction of its far plane. Works for every camera
 *  that renders it (main, reflector, cube camera), because it runs per render. */
function pinToCamera(obj: Object3D, fraction: number): void {
  obj.onBeforeRender = (_r, _s, camera: Camera) => {
    const far = (camera as PerspectiveCamera).far ?? 1000
    obj.position.copy(camera.position)
    obj.scale.setScalar(far * fraction)
    obj.updateMatrixWorld()
  }
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uNadir;
uniform vec3 uGlow;
uniform vec3 uGlowDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.6, h));
  col = mix(col, uNadir, smoothstep(0.0, -0.2, h));
  vec2 hd = normalize(d.xz + 1e-5);
  float g = max(dot(hd, normalize(uGlowDir.xz)), 0.0);
  col += uGlow * pow(g, 5.0) * exp(-abs(h) * 9.0);
  // Dither against banding in the near-black gradient.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 400.0;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export type SkyVariant = 'main' | 'env'

export function createSkyMaterial(variant: SkyVariant): ShaderMaterial {
  const env = variant === 'env'
  return new ShaderMaterial({
    uniforms: {
      uZenith: { value: new Color('#010102') },
      uHorizon: { value: new Color(env ? '#16130f' : '#0b0a09') },
      uNadir: { value: new Color(env ? '#0c0b0a' : '#040404') },
      uGlow: { value: new Color(PALETTE.ember).multiplyScalar(env ? 0.22 : 0.06) },
      uGlowDir: { value: new Vector3(-0.8, 0, 0.6) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
  })
}

export function SkyDome({ variant = 'main' }: { variant?: SkyVariant }) {
  const ref = useRef<Mesh>(null)
  const geometry = useMemo(() => new SphereGeometry(1, 48, 24), [])
  const material = useMemo(() => createSkyMaterial(variant), [variant])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )
  useLayoutEffect(() => {
    if (ref.current) pinToCamera(ref.current, 0.92)
  }, [])
  // Solid layer: the floor reflects the sky gradient (but not the stars).
  return <mesh ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={-1000} layers={LAYER.SOLID} />
}

// ─── stars ──────────────────────────────────────────────────────────────────────────────

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uDpr;
varying vec3 vColor;
void main() {
  float tw = 0.75 + 0.25 * sin(uTime * (0.6 + aPhase * 1.7) + aPhase * 40.0);
  vColor = aColor * tw;
  gl_PointSize = aSize * uDpr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * a * a, 1.0);
  #include <colorspace_fragment>
}
`

function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createStarGeometry(count = 2600, seed = 7): BufferGeometry {
  const rand = mulberry(seed)
  const pos: number[] = []
  const size: number[] = []
  const phase: number[] = []
  const color: number[] = []
  const bone = new Color(PALETTE.bone)
  const ember = new Color(PALETTE.ember)
  const cool = new Color('#b9c4d6')
  const c = new Color()
  for (let i = 0; i < count; i++) {
    // Uniform on the upper sphere, thinning towards the horizon haze.
    const y = Math.pow(rand(), 0.8) * 1.04 - 0.04
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    pos.push(r * Math.cos(a), y, r * Math.sin(a))
    const m = rand()
    const bright = m > 0.985
    size.push(bright ? 2.6 + rand() * 1.6 : 0.9 + rand() * 1.3)
    phase.push(rand())
    const k = rand()
    c.copy(k < 0.08 ? ember : k < 0.3 ? cool : bone)
    // HDR for the few bright ones so they bloom; the rest stay faint.
    const lum = bright ? 3.2 + rand() * 2 : 0.18 + Math.pow(rand(), 3) * 0.9
    color.push(c.r * lum, c.g * lum, c.b * lum)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('aSize', new Float32BufferAttribute(size, 1))
  g.setAttribute('aPhase', new Float32BufferAttribute(phase, 1))
  g.setAttribute('aColor', new Float32BufferAttribute(color, 3))
  return g
}

export function Stars() {
  const ref = useRef<Points>(null)
  const dpr = useThree((s) => s.viewport.dpr)
  const geometry = useMemo(() => createStarGeometry(), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uDpr: { value: 1 } },
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    [],
  )
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )
  useEffect(() => {
    material.uniforms.uDpr.value = dpr
  }, [dpr, material])
  useLayoutEffect(() => {
    if (ref.current) pinToCamera(ref.current, 0.86)
  }, [])
  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime
  })
  // GLASS layer: the reflector camera (layer 0 only) skips them.
  return (
    <points
      ref={ref}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      layers={LAYER.GLASS}
      renderOrder={RENDER_ORDER.DUST - 1}
    />
  )
}

// ─── image-based environment ────────────────────────────────────────────────────────────

export function EnvironmentLighting({ intensity = 0.85 }: { intensity?: number }) {
  return (
    <Environment frames={1} resolution={256} environmentIntensity={intensity}>
      <SkyDome variant="env" />
      {/* Overcast zenith panel: the broad cool highlight on chrome and the concrete's top light. */}
      <Lightformer form="rect" intensity={1.1} color="#d6d2ca" position={[0, 90, 0]} rotation-x={Math.PI / 2} scale={[140, 140, 1]} />
      {/* Low ember band on one horizon: warm rims on brass. */}
      <Lightformer form="rect" intensity={3.2} color={PALETTE.ember} position={[-110, 6, 70]} scale={[120, 8, 1]} target={[0, 6, 0]} />
      {/* Signal-orange ring opposite: a hard accent in polished metal. */}
      <Lightformer form="ring" intensity={5} color={PALETTE.signal} position={[95, 28, -80]} scale={14} target={[0, 0, 0]} />
      {/* Cold slit for chrome edges. */}
      <Lightformer form="rect" intensity={2.2} color="#c9d2e0" position={[40, 20, 120]} scale={[6, 80, 1]} target={[0, 10, 0]} />
      {/* Floor bounce. */}
      <Lightformer form="rect" intensity={0.35} color={PALETTE.concrete} position={[0, -30, 0]} rotation-x={-Math.PI / 2} scale={[200, 200, 1]} />
    </Environment>
  )
}

/** Direct light: a high, cool key that rakes across board-formed surfaces. */
export function EnvironmentLights() {
  return (
    <>
      <directionalLight position={[120, 260, 70]} intensity={1.7} color="#e2dccf" />
      <directionalLight position={[-160, 60, -120]} intensity={0.28} color={PALETTE.ember} />
      <ambientLight intensity={0.035} color="#c8c4bc" />
    </>
  )
}
