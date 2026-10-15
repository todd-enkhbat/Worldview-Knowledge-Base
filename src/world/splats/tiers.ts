import { create } from 'zustand'

// Splat residency tiers (PLAN Phase 2, "tier manager"). Pure policy plus a small store the
// HUD reads; no three or Spark imports so it runs in node tests.
//
//   impostor  the thumbnail sprite: every memory with a thumb that is not resident
//   proxy     the ≤ 100k non-LoD SplatMesh, for the nearest ≤ 6 memories, with hysteresis so
//             a camera hovering at the boundary does not load/unload every frame
//   focused   exactly one memory (useApp.focusedId): its proxy plus the lod:true interior
//
// Budget: Σ rendered proxies + the focused interior's LoD cut ≤ 2M splats, enforced by
// lowering the one SparkRenderer's lodSplatCount (proxies are non-LoD and always draw in full).

export type SplatTier = 'none' | 'impostor' | 'proxy' | 'focused'

export interface TierLimits {
  /** Resident proxies, the focused memory excluded. */
  maxProxies: number
  /** A memory becomes a proxy candidate inside this camera distance (world units)... */
  enterDistance: number
  /** ...and stays one until it is farther than this (hysteresis band). */
  exitDistance: number
  /**
   * An incumbent proxy is ranked as if this fraction closer, so a newcomer must be
   * meaningfully nearer to evict it (rank hysteresis, on top of the distance band).
   */
  incumbentBonus: number
  /** Σ proxies + focused LoD splats (PLAN: 2M). */
  splatBudget: number
  /** Never starve the focused interior below this many LoD splats. */
  minLodSplats: number
}

export const TIER_LIMITS: TierLimits = {
  maxProxies: 6,
  enterDistance: 60,
  exitDistance: 75,
  incumbentBonus: 0.15,
  splatBudget: 2_000_000,
  minLodSplats: 250_000,
}

export interface TierCandidate {
  id: string
  /** Camera → memory distance (world units). Infinity when the memory has no pose. */
  distance: number
  /** Born (visible) in the current time slice; unborn memories are ghosts and get 'none'. */
  born: boolean
  hasProxy: boolean
  hasThumb: boolean
  /** Has a proxy or an interior to focus. */
  canFocus: boolean
}

/**
 * Assign a tier to every candidate. `prev` is the last assignment (for hysteresis). Exactly
 * one candidate is 'focused' when focusedId names a focusable one, regardless of distance
 * or birth (the fly-in and framing need it even if the playhead hides the memory).
 */
export function assignTiers(
  candidates: readonly TierCandidate[],
  focusedId: string | null,
  prev: ReadonlyMap<string, SplatTier>,
  limits: TierLimits = TIER_LIMITS,
): Map<string, SplatTier> {
  const out = new Map<string, SplatTier>()
  const ranked: { id: string; key: number }[] = []
  for (const c of candidates) {
    if (c.id === focusedId && c.canFocus) {
      out.set(c.id, 'focused')
      continue
    }
    const wasProxy = prev.get(c.id) === 'proxy' || prev.get(c.id) === 'focused'
    const limit = wasProxy ? limits.exitDistance : limits.enterDistance
    if (c.born && c.hasProxy && c.distance <= limit) {
      ranked.push({ id: c.id, key: c.distance * (wasProxy ? 1 - limits.incumbentBonus : 1) })
    }
  }
  // Stable order for equal keys (ids are unique), so ties never flip between frames.
  ranked.sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const proxies = new Set(ranked.slice(0, limits.maxProxies).map((r) => r.id))
  for (const c of candidates) {
    if (out.has(c.id)) continue
    if (proxies.has(c.id)) out.set(c.id, 'proxy')
    else out.set(c.id, c.born && c.hasThumb ? 'impostor' : 'none')
  }
  return out
}

/** True when two assignments differ (cheap check before publishing to React). */
export function tiersChanged(a: ReadonlyMap<string, SplatTier>, b: ReadonlyMap<string, SplatTier>): boolean {
  if (a.size !== b.size) return true
  for (const [id, t] of a) if (b.get(id) !== t) return true
  return false
}

/**
 * The SparkRenderer lodSplatCount that keeps Σ proxies + focused ≤ budget: the quality
 * ladder's count, lowered by the splats the resident (non-LoD) proxies already draw, never
 * below the floor. The quality ladder may only lower it further.
 */
export function lodSplatBudget(qualityLodSplats: number, residentProxySplats: number, limits: TierLimits = TIER_LIMITS): number {
  const room = limits.splatBudget - Math.max(0, residentProxySplats)
  return Math.max(Math.min(limits.minLodSplats, qualityLodSplats), Math.min(qualityLodSplats, room))
}

// ─── crystallising progress (the focused interior) ───────────────────────────────────

export type CrystalPhase = 'idle' | 'loading' | 'decoding' | 'growing' | 'fading' | 'ready' | 'error'

const PHASE_SPAN: Record<CrystalPhase, [number, number]> = {
  idle: [0, 0],
  loading: [0, 0.15],
  decoding: [0.15, 0.45],
  growing: [0.45, 0.85],
  fading: [0.85, 1],
  ready: [1, 1],
  error: [0, 0],
}

/** Overall progress in [0, 1] for a phase and the fraction done within it. */
export function crystalProgress(phase: CrystalPhase, within = 0): number {
  const [a, b] = PHASE_SPAN[phase]
  const f = Math.min(1, Math.max(0, within))
  return a + (b - a) * f
}

export interface CrystalState {
  /** Memory whose interior is crystallising (the focused one), or null. */
  id: string | null
  phase: CrystalPhase
  /** [0, 1] for the HUD bar. */
  progress: number
  error?: string
}

// ─── store (HUD-facing; written by the tier manager at a few Hz, never per frame) ────

export interface SplatTierState {
  tiers: ReadonlyMap<string, SplatTier>
  crystal: CrystalState
  /** Σ splats of proxies currently drawn, and the lodSplatCount last applied. */
  residentProxySplats: number
  lodSplatCount: number
}

export const useSplatTiers = create<SplatTierState>()(() => ({
  tiers: new Map(),
  crystal: { id: null, phase: 'idle', progress: 0 },
  residentProxySplats: 0,
  lodSplatCount: 0,
}))

/** Publish crystal progress; skips no-op updates so subscribers do not re-render. */
export function publishCrystal(next: CrystalState): void {
  const cur = useSplatTiers.getState().crystal
  const rounded = Math.round(next.progress * 100) / 100
  if (cur.id === next.id && cur.phase === next.phase && cur.progress === rounded && cur.error === next.error) return
  useSplatTiers.setState({ crystal: { ...next, progress: rounded } })
}
