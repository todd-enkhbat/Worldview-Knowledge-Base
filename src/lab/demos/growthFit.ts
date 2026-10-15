// Growth-rate fit for the lab's entropy curve (float64 diagnostics; nothing feeds back).
//
// Model: S(t) = S_plat − (S_plat − S₀)·e^{−t/τ}, i.e. S = a + b·e^{−t/τ}. For a fixed τ the
// model is linear in (a, b), so the least-squares (a, b) is closed form; τ is found by a
// log-spaced scan followed by golden-section refinement of the residual. The fit reports
// the timescale τ, the fitted plateau and the residuals, plus the model-free crossing
// times the acceptance criterion S uses (first t with (S − S₀)/(S_plat − S₀) ≥ 0.5, 0.95,
// with S_plat the mean over the second half of the series).

export interface GrowthFit {
  /** e-folding time of the approach to the plateau (s). */
  readonly tau: number
  /** Growth rate 1/τ (1/s). */
  readonly rate: number
  /** Fitted plateau a and initial value a + b. */
  readonly plateau: number
  readonly s0Fit: number
  readonly rmse: number
  /** Coefficient of determination of the fit. */
  readonly r2: number
  /** Measured S at t = 0 and the empirical plateau (mean of the second half). */
  readonly s0: number
  readonly plateauEmpirical: number
  readonly plateauSd: number
  /** First sample time with normalised rise ≥ 0.5 / 0.95 (null if never). */
  readonly t50: number | null
  readonly t95: number | null
  /** Samples used. */
  readonly n: number
}

interface LinFit {
  a: number
  b: number
  sse: number
}

function linearFit(t: ArrayLike<number>, s: ArrayLike<number>, tau: number): LinFit {
  // Least squares of s ≈ a + b·e, e = exp(−t/τ).
  const n = t.length
  let se = 0
  let see = 0
  let ss = 0
  let sse_ = 0
  for (let i = 0; i < n; i++) {
    const e = Math.exp(-t[i] / tau)
    se += e
    see += e * e
    ss += s[i]
    sse_ += s[i] * e
  }
  const det = n * see - se * se
  let a: number
  let b: number
  if (Math.abs(det) < 1e-12) {
    a = ss / n
    b = 0
  } else {
    b = (n * sse_ - se * ss) / det
    a = (ss - b * se) / n
  }
  let sse = 0
  for (let i = 0; i < n; i++) {
    const r = s[i] - (a + b * Math.exp(-t[i] / tau))
    sse += r * r
  }
  return { a, b, sse }
}

/** First time the normalised rise reaches `level` (null if never). */
export function crossingTime(t: ArrayLike<number>, s: ArrayLike<number>, s0: number, plateau: number, level: number): number | null {
  const span = plateau - s0
  if (!(Math.abs(span) > 0)) return null
  for (let i = 0; i < t.length; i++) if ((s[i] - s0) / span >= level) return t[i]
  return null
}

/**
 * Fit S(t) (t in seconds, ascending, t[0] = 0) to a single-exponential approach. `tauMin`
 * and `tauMax` bound the search (default: 1/4 of the first sample spacing to the series
 * length).
 */
export function fitGrowth(t: ArrayLike<number>, s: ArrayLike<number>, opts: { tauMin?: number; tauMax?: number } = {}): GrowthFit {
  const n = Math.min(t.length, s.length)
  if (n < 4) throw new Error('fitGrowth needs at least 4 samples')
  const span = t[n - 1] - t[0]
  const dt0 = Math.max(1e-6, t[1] - t[0])
  const lo = Math.log(opts.tauMin ?? dt0 / 4)
  const hi = Math.log(opts.tauMax ?? Math.max(span, dt0))
  // Coarse scan in log τ.
  const STEPS = 160
  let best = 0
  let bestSse = Infinity
  for (let k = 0; k <= STEPS; k++) {
    const sse = linearFit(t, s, Math.exp(lo + ((hi - lo) * k) / STEPS)).sse
    if (sse < bestSse) {
      bestSse = sse
      best = k
    }
  }
  // Golden-section refinement in the bracketing cell pair.
  let a = lo + ((hi - lo) * Math.max(0, best - 1)) / STEPS
  let b = lo + ((hi - lo) * Math.min(STEPS, best + 1)) / STEPS
  const g = (Math.sqrt(5) - 1) / 2
  let c = b - g * (b - a)
  let d = a + g * (b - a)
  let fc = linearFit(t, s, Math.exp(c)).sse
  let fd = linearFit(t, s, Math.exp(d)).sse
  for (let it = 0; it < 60; it++) {
    if (fc < fd) {
      b = d
      d = c
      fd = fc
      c = b - g * (b - a)
      fc = linearFit(t, s, Math.exp(c)).sse
    } else {
      a = c
      c = d
      fc = fd
      d = a + g * (b - a)
      fd = linearFit(t, s, Math.exp(d)).sse
    }
  }
  const tau = Math.exp((a + b) / 2)
  const fit = linearFit(t, s, tau)
  let mean = 0
  for (let i = 0; i < n; i++) mean += s[i]
  mean /= n
  let sst = 0
  for (let i = 0; i < n; i++) sst += (s[i] - mean) ** 2
  // Empirical plateau: the second half of the series (as the acceptance criterion S).
  const tMid = t[0] + span / 2
  let pm = 0
  let pc = 0
  for (let i = 0; i < n; i++) {
    if (t[i] >= tMid) {
      pm += s[i]
      pc++
    }
  }
  pm /= Math.max(1, pc)
  let pv = 0
  for (let i = 0; i < n; i++) if (t[i] >= tMid) pv += (s[i] - pm) ** 2
  const plateauSd = pc > 1 ? Math.sqrt(pv / (pc - 1)) : 0
  return {
    tau,
    rate: 1 / tau,
    plateau: fit.a,
    s0Fit: fit.a + fit.b,
    rmse: Math.sqrt(fit.sse / n),
    r2: sst > 0 ? 1 - fit.sse / sst : 1,
    s0: s[0],
    plateauEmpirical: pm,
    plateauSd,
    t50: crossingTime(t, s, s[0], pm, 0.5),
    t95: crossingTime(t, s, s[0], pm, 0.95),
    n,
  }
}
