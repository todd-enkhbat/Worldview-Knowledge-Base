import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { Color, Matrix4, Uniform, type Camera, type WebGLRenderer, type WebGLRenderTarget } from 'three'

// Depth-based post fog: exp² by view distance plus analytic exponential height fog.
//
// Why post and not scene fog: Spark ignores THREE.FogExp2, so scene fog would leave the
// splats crisp in a hazy world. Reading the depth buffer gives one fog for everything.
// Splats write no depth; the depth-only back-face proxies (RENDER_ORDER.DEPTH_PROXY,
// colorWrite off, depthWrite on) give each diorama cube a depth so it is fogged as a
// solid volume instead of as the sky behind it.
//
// Height fog density ρ(y) = a · e^(−b (y − base)): dense at the bottom of the time column
// (the distant past), thinning toward the present. Its optical depth along a ray of length
// d from the camera at height y₀ with direction slope dy is closed-form:
//   τ = a · e^(−b (y₀ − base)) · d · (1 − e^(−b·dy·d)) / (b·dy·d)
// Background pixels (depth = 1) get only the height term over `skyDistance`, so the horizon
// hazes over while stars overhead stay visible.

const fragmentShader = /* glsl */ `
uniform vec3 fogColor;
uniform float fogDensity;
uniform float fogHeightDensity;
uniform float fogHeightFalloff;
uniform float fogHeightBase;
uniform float fogHeightMix;
uniform float fogSkyDistance;
uniform float fogMaxOpacity;
uniform mat4 fogProjInv;
uniform mat4 fogCamWorld;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 farH = fogProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rayV = farH.xyz / farH.w;
  bool sky = depth >= 0.999999;

  float dist;
  if (sky) {
    dist = fogSkyDistance;
  } else {
    float viewZ = getViewZ(depth);
    dist = length(rayV * (viewZ / rayV.z));
  }

  vec3 dirW = normalize(mat3(fogCamWorld) * rayV);
  float camY = fogCamWorld[3].y;

  float b = fogHeightFalloff;
  float k = clamp(b * dirW.y * dist, -80.0, 80.0);
  float shape = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k;
  float tauH = fogHeightDensity * exp(clamp(-b * (camY - fogHeightBase), -80.0, 80.0)) * dist * shape;

  float dd = sky ? 0.0 : fogDensity * dist;
  float tau = dd * dd + fogHeightMix * max(tauH, 0.0);
  float fogAmount = min(1.0 - exp(-tau), fogMaxOpacity);

  outputColor = vec4(mix(inputColor.rgb, fogColor, fogAmount), inputColor.a);
}
`

export interface FogEffectOptions {
  /** Linear-RGB fog colour; should match the sky's horizon. */
  color?: Color
  /** exp² density per world unit (τ = (density · d)²). */
  density?: number
  /** Height-fog extinction per world unit at `heightBase`. */
  heightDensity?: number
  /** Height-fog falloff b per world unit (1/b is the scale height). */
  heightFalloff?: number
  /** World Y where the height fog has density `heightDensity` (the bottom of the world). */
  heightBase?: number
  /** Ray length assumed for background pixels (height fog only). */
  skyDistance?: number
  /** Cap on fog opacity, so emissive beacons still read through the far haze. */
  maxOpacity?: number
}

export const FOG_DEFAULTS = {
  // Warm near-black: one step above the void sky so far concrete dissolves into haze.
  color: new Color(0.0125, 0.0118, 0.011),
  // ≈ 15 % fog at 100 u and ≈ 50 % at 300 u along the ground; ≈ 85 % at 600 u.
  density: 0.0016,
  heightDensity: 0.0016,
  // 350 u scale height: the haze thins through the first few centuries of the column.
  // Total vertical depth a/b ≈ 0.56, so stars overhead stay visible from the ground.
  heightFalloff: 1 / 350,
  heightBase: 0,
  skyDistance: 900,
  maxOpacity: 0.985,
} as const

export class FogEffect extends Effect {
  private camera: Camera | null

  constructor(camera: Camera | null = null, options: FogEffectOptions = {}) {
    const o = { ...FOG_DEFAULTS, ...options }
    super('FogEffect', fragmentShader, {
      // SRC: the composer's input alpha can be 0 where the sky was cleared, and NORMAL
      // blending would then skip those pixels entirely.
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['fogColor', new Uniform(o.color.clone())],
        ['fogDensity', new Uniform(o.density)],
        ['fogHeightDensity', new Uniform(o.heightDensity)],
        ['fogHeightFalloff', new Uniform(o.heightFalloff)],
        ['fogHeightBase', new Uniform(o.heightBase)],
        ['fogHeightMix', new Uniform(1)],
        ['fogSkyDistance', new Uniform(o.skyDistance)],
        ['fogMaxOpacity', new Uniform(o.maxOpacity)],
        ['fogProjInv', new Uniform(new Matrix4())],
        ['fogCamWorld', new Uniform(new Matrix4())],
      ]),
    })
    this.camera = camera
  }

  /** EffectPass hands every effect the main camera. */
  override set mainCamera(camera: Camera) {
    this.camera = camera
  }

  private u<T>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>
  }

  get color(): Color {
    return this.u<Color>('fogColor').value
  }
  get density(): number {
    return this.u<number>('fogDensity').value
  }
  set density(v: number) {
    this.u<number>('fogDensity').value = v
  }
  get heightDensity(): number {
    return this.u<number>('fogHeightDensity').value
  }
  set heightDensity(v: number) {
    this.u<number>('fogHeightDensity').value = v
  }
  get heightFalloff(): number {
    return this.u<number>('fogHeightFalloff').value
  }
  set heightFalloff(v: number) {
    this.u<number>('fogHeightFalloff').value = v
  }
  get heightBase(): number {
    return this.u<number>('fogHeightBase').value
  }
  set heightBase(v: number) {
    this.u<number>('fogHeightBase').value = v
  }
  /** 0..1 weight of the height term; PostStack eases it for mode changes. */
  get heightMix(): number {
    return this.u<number>('fogHeightMix').value
  }
  set heightMix(v: number) {
    this.u<number>('fogHeightMix').value = v
  }
  get skyDistance(): number {
    return this.u<number>('fogSkyDistance').value
  }
  set skyDistance(v: number) {
    this.u<number>('fogSkyDistance').value = v
  }
  get maxOpacity(): number {
    return this.u<number>('fogMaxOpacity').value
  }
  set maxOpacity(v: number) {
    this.u<number>('fogMaxOpacity').value = v
  }

  override update(_renderer: WebGLRenderer, _inputBuffer: WebGLRenderTarget, _deltaTime?: number): void {
    const cam = this.camera
    if (!cam) return
    // The RenderPass has just rendered with this camera, so its matrices are current.
    this.u<Matrix4>('fogProjInv').value.copy(cam.projectionMatrixInverse)
    this.u<Matrix4>('fogCamWorld').value.copy(cam.matrixWorld)
  }
}
