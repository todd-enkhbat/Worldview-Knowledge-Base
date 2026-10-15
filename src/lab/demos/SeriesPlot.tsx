import { useMemo } from 'react'

// A small SVG line plot for the lab panels: several series, 1-2-5 ticks, optional
// reference lines. Hard edges, mono type, colour tokens from @theme (CSS variables).

export interface PlotSeries {
  readonly id: string
  readonly points: readonly (readonly [number, number])[]
  /** CSS colour, e.g. 'var(--color-ember)'. */
  readonly color: string
  readonly label?: string
  readonly dashed?: boolean
  readonly width?: number
}

export interface PlotLine {
  readonly at: number
  readonly color: string
  readonly label?: string
}

export interface SeriesPlotProps {
  readonly series: readonly PlotSeries[]
  readonly height?: number
  readonly xLabel?: string
  readonly yLabel?: string
  readonly hLines?: readonly PlotLine[]
  readonly vLines?: readonly PlotLine[]
  readonly xDomain?: readonly [number, number]
  readonly yDomain?: readonly [number, number]
  /** Max vertices drawn per series (longer series are strided). */
  readonly maxPoints?: number
}

const W = 720
const PAD = { l: 52, r: 12, t: 10, b: 30 }

/** "Nice" ticks (1-2-5 × 10^k) covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 6): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (hi <= lo) return [lo]
  const raw = (hi - lo) / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

function fmtTick(v: number): string {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e4 || a < 1e-2) return v.toExponential(0)
  return Number.isInteger(v) ? String(v) : v.toFixed(a < 1 ? 2 : 1)
}

export function SeriesPlot({ series, height = 220, xLabel, yLabel, hLines = [], vLines = [], xDomain, yDomain, maxPoints = 1500 }: SeriesPlotProps) {
  const H = height
  const geo = useMemo(() => {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const s of series) {
      for (const [x, y] of s.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    for (const l of hLines) {
      y0 = Math.min(y0, l.at)
      y1 = Math.max(y1, l.at)
    }
    if (xDomain) [x0, x1] = xDomain
    if (yDomain) [y0, y1] = yDomain
    if (!Number.isFinite(x0)) {
      x0 = 0
      x1 = 1
    }
    if (!Number.isFinite(y0)) {
      y0 = 0
      y1 = 1
    }
    if (x1 <= x0) x1 = x0 + 1
    if (y1 <= y0) {
      y0 -= 0.5
      y1 += 0.5
    } else if (!yDomain) {
      const m = 0.06 * (y1 - y0)
      y0 -= m
      y1 += m
    }
    const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r)
    const sy = (y: number) => H - PAD.b - ((y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b)
    const paths = series.map((s) => {
      const stride = Math.max(1, Math.ceil(s.points.length / maxPoints))
      let d = ''
      let pen = false
      for (let i = 0; i < s.points.length; i++) {
        if (i % stride !== 0 && i !== s.points.length - 1) continue
        const [x, y] = s.points[i]
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          pen = false
          continue
        }
        d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`
        pen = true
      }
      return { s, d }
    })
    return { x0, x1, y0, y1, sx, sy, paths, xt: niceTicks(x0, x1), yt: niceTicks(y0, y1, 5) }
  }, [series, hLines, xDomain, yDomain, H, maxPoints])

  const { sx, sy, paths, xt, yt, x0, x1, y0, y1 } = geo
  const inX = (x: number) => x >= x0 && x <= x1
  const inY = (y: number) => y >= y0 && y <= y1
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={yLabel ? `${yLabel} plot` : 'plot'}>
        <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="none" stroke="var(--color-bone)" strokeOpacity={0.18} />
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="var(--color-bone)" strokeOpacity={0.07} />
            <text x={PAD.l - 6} y={sy(v) + 3} textAnchor="end" fontSize={10} fill="var(--color-concrete)" fontFamily="var(--font-mono, monospace)">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={sx(v)} x2={sx(v)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-bone)" strokeOpacity={0.07} />
            <text x={sx(v)} y={H - PAD.b + 13} textAnchor="middle" fontSize={10} fill="var(--color-concrete)" fontFamily="var(--font-mono, monospace)">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {hLines.filter((l) => inY(l.at)).map((l, i) => (
          <g key={`h${i}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(l.at)} y2={sy(l.at)} stroke={l.color} strokeDasharray="4 3" strokeWidth={1} />
            {l.label && (
              <text x={W - PAD.r - 4} y={sy(l.at) - 4} textAnchor="end" fontSize={10} fill={l.color} fontFamily="var(--font-mono, monospace)">
                {l.label}
              </text>
            )}
          </g>
        ))}
        {vLines.filter((l) => inX(l.at)).map((l, i) => (
          <g key={`v${i}`}>
            <line x1={sx(l.at)} x2={sx(l.at)} y1={PAD.t} y2={H - PAD.b} stroke={l.color} strokeDasharray="2 3" strokeWidth={1} />
            {l.label && (
              <text x={sx(l.at) + 3} y={PAD.t + 10} fontSize={10} fill={l.color} fontFamily="var(--font-mono, monospace)">
                {l.label}
              </text>
            )}
          </g>
        ))}
        {paths.map(({ s, d }) => (
          <path key={s.id} d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.5} strokeDasharray={s.dashed ? '5 4' : undefined} />
        ))}
        {xLabel && (
          <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize={10} fill="var(--color-concrete)" fontFamily="var(--font-mono, monospace)">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text x={4} y={PAD.t + 8} fontSize={10} fill="var(--color-concrete)" fontFamily="var(--font-mono, monospace)">
            {yLabel}
          </text>
        )}
      </svg>
      {series.some((s) => s.label) && (
        <div className="mt-1 flex flex-wrap gap-4 font-mono text-[10px] uppercase tracking-wider text-concrete">
          {series
            .filter((s) => s.label)
            .map((s) => (
              <span key={s.id} className="flex items-center gap-1.5">
                <span className="inline-block h-[2px] w-4" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
