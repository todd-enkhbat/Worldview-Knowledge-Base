// GPU time of each perf frame's render + post, via EXT_disjoint_timer_query_webgl2
// (Chrome; Safari has no timer queries, so the report says null there).
//
// Only one TIME_ELAPSED query may be active per context, and the dust layer times its own
// k-step loop with one in its default-priority useFrame. This query therefore opens after
// that (priority 0.5) and closes after the frame's last pass: it covers the scene render,
// Spark and the post stack, not the dust stepping (budgeted at ≈ 3.5 ms by its own timer).

interface TimerExt {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

interface Pending<T> {
  readonly query: WebGLQuery
  readonly tag: T
}

export class FrameGpuTimer<T> {
  private readonly gl: WebGL2RenderingContext
  private readonly ext: TimerExt
  private readonly inFlight: Pending<T>[] = []
  private open: WebGLQuery | null = null
  private readonly maxInFlight: number
  /** Results discarded because the GPU reported a disjoint event. */
  disjoint = 0

  private constructor(gl: WebGL2RenderingContext, ext: TimerExt, maxInFlight: number) {
    this.gl = gl
    this.ext = ext
    this.maxInFlight = maxInFlight
  }

  static create<T>(gl: WebGL2RenderingContext, maxInFlight = 8): FrameGpuTimer<T> | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null
    return ext ? new FrameGpuTimer<T>(gl, ext, maxInFlight) : null
  }

  begin(): boolean {
    if (this.open || this.inFlight.length >= this.maxInFlight) return false
    const q = this.gl.createQuery()
    if (!q) return false
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.open = q
    return true
  }

  /** Close the open query; `tag` comes back with its result. */
  end(tag: T): void {
    if (!this.open) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.inFlight.push({ query: this.open, tag })
    this.open = null
  }

  /** Deliver finished results in order (ms). */
  poll(onResult: (tag: T, ms: number) => void): void {
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    while (this.inFlight.length > 0) {
      const p = this.inFlight[0]
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break
      this.inFlight.shift()
      if (disjoint) this.disjoint++
      else onResult(p.tag, (gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number) / 1e6)
      gl.deleteQuery(p.query)
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
