// Time-slicing of the dust stepping: ≈ 3–4 ms of GPU per frame (PLAN "Dust (GPU)").
// GPU cost is proportional to texel-steps (texels drawn × kernel steps), so the budget is
// kept in texel-steps. With EXT_disjoint_timer_query_webgl2 the cost per texel-step is
// measured (results arrive a few frames late; disjoint results are discarded); without it
// (Safari) a conservative fixed budget is used.

export interface StepBudgetOptions {
  /** GPU milliseconds per frame for dust stepping. */
  readonly budgetMs?: number
  /** Texel-steps per frame without a timer: 16 steps of the full 131k budget. */
  readonly fallbackTexelSteps?: number
  /** Bounds on kernel steps per frame. */
  readonly minSteps?: number
  readonly maxSteps?: number
}

const DEFAULTS = { budgetMs: 3.5, fallbackTexelSteps: 16 * 131072, minSteps: 1, maxSteps: 4096 }

/** Kernel steps for this frame over `texels` drawn texels, from the measured ns per texel-step (or null). */
export function stepBudget(texels: number, nsPerTexelStep: number | null, opts: StepBudgetOptions = {}): number {
  const o = { ...DEFAULTS, ...opts }
  const t = Math.max(1, texels)
  const raw = nsPerTexelStep !== null && nsPerTexelStep > 0 ? (o.budgetMs * 1e6) / (nsPerTexelStep * t) : o.fallbackTexelSteps / t
  const steps = Math.floor(raw)
  return steps < o.minSteps ? o.minSteps : steps > o.maxSteps ? o.maxSteps : steps
}

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

interface Pending {
  readonly query: WebGLQuery
  readonly texelSteps: number
}

/**
 * Wraps one TIME_ELAPSED query per frame around the dust draws and keeps an exponential
 * average of ns per texel-step. Only one TIME_ELAPSED query may be active per context, so
 * begin() refuses while one is open and at most `maxInFlight` results are outstanding.
 */
export class GpuStepTimer {
  /** Smoothed GPU ns per texel-step, or null before the first result. */
  nsPerTexelStep: number | null = null
  private readonly gl: WebGL2RenderingContext
  private readonly ext: TimerQueryExt
  private readonly inFlight: Pending[] = []
  private open: WebGLQuery | null = null
  private readonly maxInFlight: number
  private readonly alpha: number

  private constructor(gl: WebGL2RenderingContext, ext: TimerQueryExt, maxInFlight: number, alpha: number) {
    this.gl = gl
    this.ext = ext
    this.maxInFlight = maxInFlight
    this.alpha = alpha
  }

  /** Null when the extension is missing (e.g. Safari). */
  static create(gl: WebGL2RenderingContext, maxInFlight = 4, alpha = 0.2): GpuStepTimer | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null
    return ext ? new GpuStepTimer(gl, ext, maxInFlight, alpha) : null
  }

  begin(): boolean {
    if (this.open || this.inFlight.length >= this.maxInFlight) return false
    const q = this.gl.createQuery()
    if (!q) return false
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.open = q
    return true
  }

  end(texelSteps: number): void {
    if (!this.open) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.inFlight.push({ query: this.open, texelSteps })
    this.open = null
  }

  /** Collect finished results (call once per frame, before begin()). */
  poll(): void {
    const gl = this.gl
    while (this.inFlight.length > 0) {
      const p = this.inFlight[0]
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break
      this.inFlight.shift()
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
      const ns = Number(gl.getQueryParameter(p.query, gl.QUERY_RESULT))
      gl.deleteQuery(p.query)
      // Tiny samples are dominated by fixed draw overhead; they would inflate the per-step cost.
      if (disjoint || !(ns > 0) || p.texelSteps < 4096) continue
      const v = ns / p.texelSteps
      this.nsPerTexelStep = this.nsPerTexelStep === null ? v : this.nsPerTexelStep + this.alpha * (v - this.nsPerTexelStep)
    }
  }

  dispose(): void {
    if (this.open) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.gl.deleteQuery(this.open)
      this.open = null
    }
    for (const p of this.inFlight) this.gl.deleteQuery(p.query)
    this.inFlight.length = 0
  }
}
