// WebGL2 integer GPGPU for the dust kernel: an RGBA32I MRT ping-pong (location 0 = X,
// location 1 = D), static RGBA32I anchor/birth and meta (seed, style) textures and the
// sine LUT as a 64×64 R32I texture. Built on three's WebGLRenderTarget({count: 2}) + a
// GLSL3 RawShaderMaterial so the X texture can be sampled by three materials directly;
// three's own state tracking is kept intact (render target, viewport/scissor of our own
// targets and autoClear are restored after every draw). Readback uses
// renderer.readRenderTargetPixels with RGBA_INTEGER/INT, which selects the MRT attachment
// through gl.readBuffer.
//
// Every state write is a draw: stepping (k steps in the shader loop), checkpoint copies
// and restores (0-step draws, which also re-spawn dormant texels when births are on) and
// edit rows (a patch shader scissored to one 64-texel segment). It implements DustBackend
// for DustSim; the S2 lab uses load/step/read with births off.

import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  DataTexture,
  GLSL3,
  IntType,
  Mesh,
  NearestFilter,
  NoBlending,
  RGBAIntegerFormat,
  RawShaderMaterial,
  RedIntegerFormat,
  Scene,
  type Texture,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { PhysicsParams } from '../../physics/params.ts'
import { assertSinLut } from '../../physics/sinlut.ts'
import { DUST_SEGMENT, segmentOrigin } from './alloc.ts'
import { DUST_FREE_BIRTH, type DustOwner, type DustRows, dustParticleSeed } from './dustWorld.ts'
import { dustPatchFragmentShader, dustStepFragmentShader, dustVertexShader } from './glsl.ts'
import type { DustTexels } from './layout.ts'
import { sinLutTexels } from './layout.ts'
import type { DustBackend } from './sim.ts'

/** GPU dust cannot run bit-exactly here; the caller falls back (no dust, or the CPU kernel). */
export class DustGpuUnsupportedError extends Error {
  override name = 'DustGpuUnsupportedError'
}

export interface HighIntPrecision {
  readonly rangeMin: number
  readonly rangeMax: number
  readonly precision: number
}

/**
 * docs/PHYSICS.md: the kernel needs 32-bit two's-complement highp ints in the fragment
 * stage. Refuse GPU dust unless HIGH_INT reports rangeMin ≥ 31 and rangeMax ≥ 30.
 */
export function assertHighpInt(gl: WebGL2RenderingContext, shader: GLenum = gl.FRAGMENT_SHADER): HighIntPrecision {
  const f = gl.getShaderPrecisionFormat(shader, gl.HIGH_INT)
  if (!f) throw new DustGpuUnsupportedError('getShaderPrecisionFormat(HIGH_INT) returned null')
  const p = { rangeMin: f.rangeMin, rangeMax: f.rangeMax, precision: f.precision }
  if (p.rangeMin < 31 || p.rangeMax < 30) {
    throw new DustGpuUnsupportedError(`highp int is not 32-bit: rangeMin ${p.rangeMin}, rangeMax ${p.rangeMax}`)
  }
  return p
}

function intTexture(data: Int32Array, width: number, height: number, rgba: boolean): DataTexture {
  const t = new DataTexture(data, width, height, rgba ? RGBAIntegerFormat : RedIntegerFormat, IntType)
  t.internalFormat = rgba ? 'RGBA32I' : 'R32I'
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.flipY = false
  t.needsUpdate = true
  return t
}

function stateTarget(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    count: 2,
    type: IntType,
    format: RGBAIntegerFormat,
    internalFormat: 'RGBA32I',
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  })
}

const STEP_SHADER = 'DustStep'
const PATCH_SHADER = 'DustPatch'

export interface DustGpuOptions {
  /**
   * Births on the GPU: a texel whose birth (anchor.w) is ≥ the destination step outputs its
   * spawn state, regenerated from the anchor and meta seed (dustStepFragmentShader). The S2
   * lab runs the plain kernel (off).
   */
  readonly births?: boolean
}

export class DustGpu implements DustBackend {
  readonly width: number
  readonly height: number
  readonly precision: HighIntPrecision
  readonly births: boolean
  private readonly renderer: WebGLRenderer
  private readonly targets: [WebGLRenderTarget, WebGLRenderTarget]
  private cur = 0
  private live = 0
  private rows: number
  private readonly xIn: DataTexture
  private readonly dIn: DataTexture
  private readonly anchorTex: DataTexture
  private readonly metaTex: DataTexture
  private readonly lutTex: DataTexture
  private readonly patchX: DataTexture
  private readonly patchD: DataTexture
  private readonly material: RawShaderMaterial
  private readonly patchMaterial: RawShaderMaterial
  private readonly geometry: BufferGeometry
  private readonly scene = new Scene()
  private readonly patchScene = new Scene()
  private readonly camera = new Camera()
  private readonly probe = new Int32Array(4)
  private readonly ckpts: (WebGLRenderTarget | null)[] = []
  private readonly checked = new Set<string>()
  /** Static textures not uploaded yet: partial update ranges would leave the rest unset. */
  private staticFresh = true

  constructor(renderer: WebGLRenderer, params: PhysicsParams, width: number, height: number, opts: DustGpuOptions = {}) {
    const gl = renderer.getContext()
    if (!(gl instanceof WebGL2RenderingContext)) throw new DustGpuUnsupportedError('WebGL2 required')
    this.precision = assertHighpInt(gl)
    assertSinLut()
    this.renderer = renderer
    this.width = width
    this.height = height
    this.rows = height
    this.births = opts.births ?? false
    const texels = width * height
    this.xIn = intTexture(new Int32Array(4 * texels), width, height, true)
    this.dIn = intTexture(new Int32Array(4 * texels), width, height, true)
    const anchor = new Int32Array(4 * texels)
    for (let i = 0; i < texels; i++) anchor[4 * i + 3] = DUST_FREE_BIRTH
    this.anchorTex = intTexture(anchor, width, height, true)
    this.metaTex = intTexture(new Int32Array(4 * texels), width, height, true)
    const lut = sinLutTexels()
    this.lutTex = intTexture(lut.data, lut.width, lut.height, false)
    this.patchX = intTexture(new Int32Array(4 * DUST_SEGMENT), DUST_SEGMENT, 1, true)
    this.patchD = intTexture(new Int32Array(4 * DUST_SEGMENT), DUST_SEGMENT, 1, true)
    this.targets = [stateTarget(width, height), stateTarget(width, height)]
    this.initTargets()
    this.material = new RawShaderMaterial({
      name: STEP_SHADER,
      glslVersion: GLSL3,
      vertexShader: dustVertexShader(),
      fragmentShader: dustStepFragmentShader(params),
      uniforms: {
        uX: { value: this.xIn },
        uD: { value: this.dIn },
        uAnchor: { value: this.anchorTex },
        uMeta: { value: this.metaTex },
        uSinLut: { value: this.lutTex },
        uSteps: { value: 0 },
        uBackward: { value: 0 },
        uStep: { value: 0 },
        uBirths: { value: this.births ? 1 : 0 },
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    })
    this.patchMaterial = new RawShaderMaterial({
      name: PATCH_SHADER,
      glslVersion: GLSL3,
      vertexShader: dustVertexShader(),
      fragmentShader: dustPatchFragmentShader(),
      uniforms: {
        uPatchX: { value: this.patchX },
        uPatchD: { value: this.patchD },
        uOriginX: { value: 0 },
        uOriginY: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    })
    // One triangle covering the viewport: every texel gets exactly one fragment.
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    for (const [scene, mat] of [
      [this.scene, this.material],
      [this.patchScene, this.patchMaterial],
    ] as const) {
      const mesh = new Mesh(this.geometry, mat)
      mesh.frustumCulled = false
      scene.add(mesh)
    }
  }

  /** The current X texture (xyz Q.19, w flags), for rendering. */
  get positionTexture(): Texture {
    return this.targets[this.cur].textures[0]
  }

  /** The current D texture (xyz Q.27). */
  get velocityTexture(): Texture {
    return this.targets[this.cur].textures[1]
  }

  /** Static anchor/birth texture (w = birth), for rendering. */
  get anchorTexture(): Texture {
    return this.anchorTex
  }

  /** Static meta texture (seed, style), for rendering. */
  get metaTexture(): Texture {
    return this.metaTex
  }

  /** Step of the live state (as told by load/draw/restore). */
  get liveStep(): number {
    return this.live
  }

  /** Rows [0, rows) are stepped, copied and drawn. */
  get drawnRows(): number {
    return this.rows
  }

  /** Upload a packed state and the static inputs and load them into the ping-pong (a 0-step draw at `step`). */
  load(t: DustTexels, step = 0): void {
    if (t.width !== this.width || t.height !== this.height) throw new RangeError('texel size mismatch')
    this.xIn.image.data = t.x
    this.dIn.image.data = t.d
    this.anchorTex.image.data = t.anchor
    if (t.meta) this.metaTex.image.data = t.meta
    for (const tex of [this.xIn, this.dIn, this.anchorTex, this.metaTex]) {
      tex.clearUpdateRanges()
      tex.needsUpdate = true
    }
    this.cur = 0
    this.live = step
    this.run(this.scene, this.stepUniforms(this.xIn, this.dIn, step, 0, false), this.targets[0], null)
  }

  /** Run `steps` forward (or backward) Levesque–Verlet steps in one draw. */
  step(steps: number, backward = false): void {
    this.draw(this.live, steps, backward)
  }

  // ---- DustBackend ----

  setRows(rows: number): void {
    if (!Number.isInteger(rows) || rows < 0) throw new RangeError(`dust rows ${rows}`)
    this.rows = Math.min(rows, this.height)
  }

  draw(from: number, steps: number, backward: boolean): void {
    if (!Number.isInteger(steps) || steps < 0) throw new RangeError(`steps ${steps}`)
    const src = this.targets[this.cur]
    const dst = this.targets[1 - this.cur]
    if (this.run(this.scene, this.stepUniforms(src.textures[0], src.textures[1], from, steps, backward), dst, null)) this.cur = 1 - this.cur
    this.live = backward ? from - steps : from + steps
  }

  saveCheckpoint(slot: number, step: number): void {
    let t = this.ckpts[slot] ?? null
    if (!t) {
      t = stateTarget(this.width, this.height)
      this.ckpts[slot] = t
    }
    const src = this.targets[this.cur]
    this.run(this.scene, this.stepUniforms(src.textures[0], src.textures[1], step, 0, false), t, null)
  }

  restoreCheckpoint(slot: number, step: number): void {
    const t = this.ckpts[slot]
    if (!t) throw new RangeError(`no dust checkpoint in slot ${slot}`)
    const dst = this.targets[1 - this.cur]
    if (this.run(this.scene, this.stepUniforms(t.textures[0], t.textures[1], step, 0, false), dst, null)) this.cur = 1 - this.cur
    this.live = step
  }

  writeSegment(segment: number, owner: DustOwner | null, style: number): void {
    const first = segment * DUST_SEGMENT
    if (first < 0 || first + DUST_SEGMENT > this.width * this.height) throw new RangeError(`segment ${segment}`)
    const a = this.anchorTex.image.data as Int32Array
    const m = this.metaTex.image.data as Int32Array
    for (let k = 0; k < DUST_SEGMENT; k++) {
      const o = 4 * (first + k)
      a[o] = owner ? owner.anchor[0] | 0 : 0
      a[o + 1] = owner ? owner.anchor[1] | 0 : 0
      a[o + 2] = owner ? owner.anchor[2] | 0 : 0
      a[o + 3] = owner ? owner.birth : DUST_FREE_BIRTH
      m[o] = owner ? dustParticleSeed(owner.seed, k) : 0
      m[o + 1] = style
      m[o + 2] = 0
      m[o + 3] = 0
    }
    for (const tex of [this.anchorTex, this.metaTex]) {
      if (!this.staticFresh) tex.addUpdateRange(4 * first, 4 * DUST_SEGMENT)
      tex.needsUpdate = true
    }
  }

  patchLive(segment: number, rows: DustRows): void {
    this.patch(this.targets[this.cur], segment, rows)
  }

  patchCheckpoint(slot: number, segment: number, rows: DustRows): void {
    const t = this.ckpts[slot]
    if (!t) throw new RangeError(`no dust checkpoint in slot ${slot}`)
    this.patch(t, segment, rows)
  }

  /**
   * After a WebGL context restore three re-creates every texture from its CPU data; make
   * sure that is a full upload (pending update ranges would upload only those rows). The
   * state targets come back empty: the caller restarts the run (DustSim.reset()).
   */
  onContextRestored(): void {
    this.staticFresh = true
    for (const t of [this.xIn, this.dIn, this.anchorTex, this.metaTex, this.lutTex, this.patchX, this.patchD]) {
      t.clearUpdateRanges()
      t.needsUpdate = true
    }
    this.checked.clear()
    this.initTargets()
  }

  /**
   * Allocate both ping-pong targets now. A target three has never rendered into has no GL
   * texture yet, so sampling it binds three's 8-bit placeholder into an isampler2D unit:
   * GL_INVALID_OPERATION, and the draw (the first 0-step spawn) silently does nothing.
   */
  private initTargets(): void {
    for (const t of this.targets) this.renderer.initRenderTarget(t)
  }

  /** Read the current X and D back as RGBA texels (blocks until the GPU is done). */
  read(): { x: Int32Array; d: Int32Array } {
    const n = 4 * this.width * this.height
    const x = new Int32Array(n)
    const d = new Int32Array(n)
    const rt = this.targets[this.cur]
    this.renderer.readRenderTargetPixels(rt, 0, 0, this.width, this.height, x, undefined, 0)
    this.renderer.readRenderTargetPixels(rt, 0, 0, this.width, this.height, d, undefined, 1)
    return { x, d }
  }

  /** Block until every queued draw has finished (1-texel readback). For timing. */
  sync(): void {
    this.renderer.readRenderTargetPixels(this.targets[this.cur], 0, 0, 1, 1, this.probe, undefined, 0)
  }

  dispose(): void {
    for (const t of this.targets) t.dispose()
    for (const t of this.ckpts) t?.dispose()
    this.ckpts.length = 0
    for (const t of [this.xIn, this.dIn, this.anchorTex, this.metaTex, this.lutTex, this.patchX, this.patchD]) t.dispose()
    this.material.dispose()
    this.patchMaterial.dispose()
    this.geometry.dispose()
  }

  private stepUniforms(xTex: Texture, dTex: Texture, from: number, steps: number, backward: boolean): RawShaderMaterial {
    const u = this.material.uniforms
    u.uX.value = xTex
    u.uD.value = dTex
    u.uStep.value = from
    u.uSteps.value = steps
    u.uBackward.value = backward ? 1 : 0
    return this.material
  }

  private patch(dst: WebGLRenderTarget, segment: number, rows: DustRows): void {
    if (rows.x.length !== 4 * DUST_SEGMENT || rows.d.length !== 4 * DUST_SEGMENT) throw new RangeError('dust rows must be 64 RGBA texels')
    const { x, y } = segmentOrigin(segment, this.width)
    this.patchX.image.data = rows.x
    this.patchD.image.data = rows.d
    this.patchX.needsUpdate = true
    this.patchD.needsUpdate = true
    const u = this.patchMaterial.uniforms
    u.uOriginX.value = x
    u.uOriginY.value = y
    this.run(this.patchScene, this.patchMaterial, dst, [x, y, DUST_SEGMENT, 1])
  }

  /** One draw into `dst`; false (nothing drawn) when no rows are in use. */
  private run(scene: Scene, material: RawShaderMaterial, dst: WebGLRenderTarget, scissor: [number, number, number, number] | null): boolean {
    const rows = scissor ? this.height : this.rows
    if (rows === 0) return false
    const r = this.renderer
    const prevTarget = r.getRenderTarget()
    const prevAutoClear = r.autoClear
    // clear() on an integer color buffer is INVALID_OPERATION in WebGL2; every drawn texel is overwritten anyway.
    r.autoClear = false
    dst.viewport.set(0, 0, this.width, rows)
    dst.scissorTest = scissor !== null
    if (scissor) dst.scissor.set(scissor[0], scissor[1], scissor[2], scissor[3])
    try {
      r.setRenderTarget(dst)
      if (!this.checked.has(material.name)) this.checkFramebuffer()
      r.render(scene, this.camera)
      if (!this.checked.has(material.name)) {
        this.checkProgram(material.name)
        this.checked.add(material.name)
      }
      // The step material samples the static textures, so they are uploaded in full by now.
      if (material === this.material) this.staticFresh = false
    } finally {
      dst.scissorTest = false
      dst.viewport.set(0, 0, this.width, this.height)
      r.setRenderTarget(prevTarget)
      r.autoClear = prevAutoClear
    }
    return true
  }

  private checkFramebuffer(): void {
    const gl = this.renderer.getContext()
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new DustGpuUnsupportedError(`RGBA32I MRT framebuffer incomplete: 0x${status.toString(16)}`)
    }
  }

  private checkProgram(name: string): void {
    for (const p of this.renderer.info.programs ?? []) {
      if (p.name !== name) continue
      // diagnostics is only set by three when the program failed to link/compile.
      const diag = (p as unknown as { diagnostics?: { runnable: boolean; programLog: string; fragmentShader: { log: string } } }).diagnostics
      if (diag && !diag.runnable) {
        throw new DustGpuUnsupportedError(`dust shader ${name} failed: ${diag.programLog} ${diag.fragmentShader.log}`)
      }
    }
  }
}
