import { anchorY, radiusOf } from '../../domain/placement.ts'
import type { NodeRecord, Vec3, WorldSettings } from '../../domain/types.ts'
import { PERISTYLE_COLUMNS, PYLON_EVERY } from '../environment/layout.ts'

// The opening establishing shot: the populated stretch of the column, seen from a raised
// three-quarter view, so the first thing a viewer sees is the nodes rather than the plinth.
// Pure (records + settings → camera), so it is testable and needs no pose table.

export interface Shot {
  position: Vec3
  target: Vec3
}

/** Azimuth midway between two pylons (layout.ts), so they frame the shot instead of crossing it. */
const AZIMUTH = (0.5 + PYLON_EVERY / 2) * ((Math.PI * 2) / PERISTYLE_COLUMNS)
/** Elevation of the view direction above the horizon. */
const ELEVATION = 0.37
/** Raised three-quarter view direction (target → camera), normalised below. */
const DIR: Vec3 = [Math.cos(AZIMUTH) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.sin(AZIMUTH) * Math.cos(ELEVATION)]
/** Frame the central 10–90 % of node heights (a few outliers should not push the camera away),
 *  or the middle half when that is a dense cluster. */
const LOW_Q = 0.1
const HIGH_Q = 0.9
/** Air above and below the framed band (fractions of its height). More above: labels sit over
 *  their nodes and the top bar covers the top of the frame. At least MIN_BAND units in all. */
const MARGIN_TOP = 0.34
const MARGIN_BOTTOM = 0.16
const MIN_BAND = 60
/** Middle half narrower than this fraction of the 10–90 % band counts as a dense cluster. */
const DENSE_FRACTION = 0.25

function quantile(sorted: readonly number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/**
 * Camera framing the live nodes, or null for an empty world. `vfovDeg` and `aspect` are the
 * camera's; `maxDistance` clamps to the orbit limits.
 */
export function establishingShot(
  nodes: Iterable<NodeRecord>,
  settings: Pick<WorldSettings, 'T0' | 'yPerYear'>,
  vfovDeg: number,
  aspect: number,
  maxDistance: number,
): Shot | null {
  const ys: number[] = []
  let rMax = 0
  for (const n of nodes) {
    if (n.deletedAt !== null) continue
    ys.push(anchorY(n, settings))
    rMax = Math.max(rMax, radiusOf(n.anchorXZ))
  }
  if (ys.length === 0) return null
  ys.sort((a, b) => a - b)
  let y0 = quantile(ys, LOW_Q)
  let y1 = quantile(ys, HIGH_Q)
  // A dense cluster (the middle half within DENSE_FRACTION of the band) would be an unreadable
  // knot from far enough to see everything: frame the cluster instead, so its labels fit.
  const q0 = quantile(ys, 0.25)
  const q1 = quantile(ys, 0.75)
  if (y1 - y0 > 0 && q1 - q0 < DENSE_FRACTION * (y1 - y0)) {
    y0 = q0
    y1 = q1
  }
  const h = y1 - y0
  const band = Math.max(MIN_BAND, h * (1 + MARGIN_TOP + MARGIN_BOTTOM))
  const yc = (y0 + y1) / 2 + ((MARGIN_TOP - MARGIN_BOTTOM) * h) / 2
  const halfV = Math.tan((vfovDeg * Math.PI) / 360)
  // Fit the band vertically and the ring diameter horizontally.
  const d = Math.min(maxDistance, Math.max(band / 2 / halfV, (rMax * 1.3) / (halfV * aspect)))
  const k = Math.hypot(DIR[0], DIR[1], DIR[2])
  return {
    target: [0, yc, 0],
    position: [(DIR[0] / k) * d, yc + (DIR[1] / k) * d, (DIR[2] / k) * d],
  }
}
