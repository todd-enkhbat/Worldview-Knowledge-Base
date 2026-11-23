import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, ShaderMaterial, SphereGeometry, SRGBColorSpace, type PerspectiveCamera } from 'three'
import { useApp } from '../../app/store.ts'
import { LAYER } from '../layers.ts'

// Astronomical art surrounds the data; it is not indexed, selectable, or counted as notes.
// A fixed star catalog supplies camera parallax; the far panorama drifts almost imperceptibly.
export function advanceGalaxyTime(time: number, delta: number, flowing: boolean): number {
  return flowing ? time + Math.max(0, Math.min(delta, .1)) : time
}

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const SKY_FRAG = /* glsl */ `
uniform sampler2D uSky;
uniform float uTime;
varying vec2 vUv;
void main() {
  float drift = uTime * 0.000025;
  vec2 uv = vec2(fract(vUv.x + drift), fract((vUv.y - 0.5) * 1.65 + 0.5));
  vec3 sky = texture2D(uSky, uv).rgb;
  vec3 distant = texture2D(uSky, vec2(fract(uv.x + 0.37 - drift * 0.25), 1.0 - uv.y)).rgb;
  float seam = smoothstep(0.0, 0.02, uv.y) * smoothstep(0.0, 0.02, 1.0 - uv.y);
  sky = sky * seam + distant * 0.14;
  float luminance = max(max(sky.r, sky.g), sky.b);
  sky *= 0.32 / (1.0 + luminance * 0.7);
  gl_FragColor = vec4(vec3(0.002, 0.004, 0.009) + sky, 1.0);
}
`

function GalacticSky() {
  const texture = useTexture('/galaxy/milky-way.png')
  const ref = useRef<Mesh>(null)
  const time = useRef(0)
  const geometry = useMemo(() => new SphereGeometry(1, 72, 48), [])
  const material = useMemo(() => {
    texture.colorSpace = SRGBColorSpace
    return new ShaderMaterial({ uniforms: { uSky: { value: texture }, uTime: { value: 0 } }, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false, depthTest: false })
  }, [texture])
  useEffect(() => () => { geometry.dispose(); material.dispose() }, [geometry, material])
  useFrame(({ camera }, dt) => {
    time.current = advanceGalaxyTime(time.current, dt, useApp.getState().view.flow)
    material.uniforms.uTime.value = time.current
    const sky = ref.current
    if (!sky) return
    sky.position.copy(camera.position)
    sky.scale.setScalar((camera as PerspectiveCamera).far * .84)
  }, -1.5)
  return <mesh name="galactic-sky" ref={ref} geometry={geometry} material={material} rotation={[.55, 1.8, -.4]} renderOrder={-900} layers={LAYER.SOLID} frustumCulled={false} raycast={() => {}} />
}

const STAR_VERT = /* glsl */ `
uniform float uTime;
uniform float uDpr;
uniform float uPixel;
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
varying vec3 vColor;
varying float vPower;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uPixel / max(1.0, -mv.z), 0.8 * uDpr, 4.3 * uDpr);
  vColor = aColor;
  vPower = 0.94 + 0.06 * sin(uTime * 0.12 + aPhase);
}
`
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vPower;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p,p);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 10.0);
  float halo = exp(-r2 * 3.0) * 0.12;
  gl_FragColor = vec4(vColor * (core + halo) * vPower, (core + halo) * 0.65);
}
`

export function createParallaxStars(): BufferGeometry {
  let seed = 0x47a1c5
  const random = () => {
    seed = Math.imul(seed ^ seed >>> 15, 1 | seed)
    seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed)
    return ((seed ^ seed >>> 14) >>> 0) / 4294967296
  }
  const count = 3600
  const positions = new Float32Array(count * 3), sizes = new Float32Array(count), phases = new Float32Array(count), colors = new Float32Array(count * 3)
  const tint = new Color()
  for (let i = 0; i < count; i++) {
    const theta = random() * Math.PI * 2, y = random() * 2 - 1
    const ring = Math.sqrt(1 - y * y)
    const radius = 900 + Math.pow(random(), .8) * 5300
    positions.set([Math.cos(theta) * ring * radius, y * radius, Math.sin(theta) * ring * radius], i * 3)
    const bright = random() > .975
    sizes[i] = bright ? 3 + random() * 3 : .7 + random() * 1.4
    phases[i] = random() * Math.PI * 2
    tint.set(i % 5 === 0 ? '#8fbde8' : i % 7 === 0 ? '#e7bc8d' : i % 11 === 0 ? '#a4b5e4' : '#c6d2df').multiplyScalar(bright ? 1.6 + random() : .35 + random() * .65)
    colors.set([tint.r, tint.g, tint.b], i * 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('aSize', new BufferAttribute(sizes, 1))
  geometry.setAttribute('aPhase', new BufferAttribute(phases, 1))
  geometry.setAttribute('aColor', new BufferAttribute(colors, 3))
  return geometry
}

function ParallaxStars() {
  const ref = useRef<Group>(null)
  const time = useRef(0)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const geometry = useMemo(createParallaxStars, [])
  const material = useMemo(() => new ShaderMaterial({ uniforms: { uTime: { value: 0 }, uDpr: { value: 1 }, uPixel: { value: 700 } }, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }), [])
  useEffect(() => () => { geometry.dispose(); material.dispose() }, [geometry, material])
  useFrame(({ camera }, dt) => {
    time.current = advanceGalaxyTime(time.current, dt, useApp.getState().view.flow)
    material.uniforms.uTime.value = time.current
    material.uniforms.uDpr.value = dpr
    material.uniforms.uPixel.value = size.height * dpr / (2 * Math.tan(((camera as PerspectiveCamera).fov ?? 50) * Math.PI / 360))
    if (ref.current) {
      ref.current.position.copy(camera.position).multiplyScalar(.94)
    }
  }, -1.4)
  return <group ref={ref}><points name="parallax-stars" geometry={geometry} material={material} layers={LAYER.GLASS} frustumCulled={false} renderOrder={-800} raycast={() => {}} /></group>
}

export function GalaxyEnvironment() {
  return <group name="galaxy-environment"><Suspense fallback={null}><GalacticSky /></Suspense><ParallaxStars /></group>
}
