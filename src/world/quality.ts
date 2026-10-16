import { createElement, useCallback, useEffect, useRef } from 'react'
import { PerformanceMonitor } from '@react-three/drei'
import { useApp, useWorld, type QualityState } from '../app/store.ts'
import type { QualityTier } from '../domain/types.ts'

// Adaptive quality ladder (PLAN "Rendering specifics"), applied strictly in order:
//   1. DPR 1.5 → 1.25 → 1
//   2. reflector 'full' → '512' → 'off'
//   3. DOF only during fly-in
//   4. lodSplatCount down in 25 % steps, floor 400k
// Descending is quick (the frame is already bad); climbing back needs sustained headroom,
// a cooldown since the last change, and backs off exponentially if a climb immediately
// fails again, so the ladder does not oscillate around a threshold.

export type QualitySettings = Omit<QualityState, 'tier'>

export const LOD_SPLAT_MAX = 1_500_000
export const LOD_SPLAT_FLOOR = 400_000
const LOD_STEP = 0.75

/** Every rung of the ladder, best first. Pure; exported for tests and the perf lab. */
export function buildQualityLadder(maxLod = LOD_SPLAT_MAX, floorLod = LOD_SPLAT_FLOOR): QualitySettings[] {
  const top: QualitySettings = { dpr: 1.5, reflector: 'full', dofOnlyFlyIn: false, lodSplatCount: maxLod }
  const rungs: QualitySettings[] = [top]
  const push = (patch: Partial<QualitySettings>) => rungs.push({ ...rungs[rungs.length - 1], ...patch })
  push({ dpr: 1.25 })
  push({ dpr: 1 })
  push({ reflector: '512' })
  push({ reflector: 'off' })
  push({ dofOnlyFlyIn: true })
  let lod = maxLod
  while (lod > floorLod) {
    lod = Math.max(floorLod, Math.round(lod * LOD_STEP))
    push({ lodSplatCount: lod })
  }
  return rungs
}

/** Pinned presets for a manual tier. 'auto' runs the ladder instead. */
export const TIER_PRESETS: Record<Exclude<QualityTier, 'auto'>, QualitySettings> = {
  high: { dpr: 1.5, reflector: 'full', dofOnlyFlyIn: false, lodSplatCount: LOD_SPLAT_MAX },
  medium: { dpr: 1.25, reflector: '512', dofOnlyFlyIn: true, lodSplatCount: 1_125_000 },
  low: { dpr: 1, reflector: 'off', dofOnlyFlyIn: true, lodSplatCount: 600_000 },
}

/** fps bounds [decline below, incline at or above], from the measured refresh rate. */
export function qualityBounds(refreshrate: number): [number, number] {
  // ProMotion / 120 Hz panels: hold ≥ 72 fps, climb when ≥ 108.
  if (refreshrate > 100) return [72, 108]
  // 60 Hz: drei's fps estimate reads ~6 % high (n stamps over n−1 intervals).
  return [50, 59]
}

const DECLINE_COOLDOWN_MS = 1500
const CLIMB_COOLDOWN_MS = 6000
const CLIMB_COOLDOWN_MAX_MS = 60_000
/** A climb that is undone within this window counts as a failed climb (backoff doubles). */
const FAILED_CLIMB_WINDOW_MS = 8000
const INCLINES_TO_CLIMB = 2

function applySettings(next: QualitySettings): void {
  const q = useApp.getState().quality
  if (
    q.dpr === next.dpr &&
    q.reflector === next.reflector &&
    q.dofOnlyFlyIn === next.dofOnlyFlyIn &&
    q.lodSplatCount === next.lodSplatCount
  )
    return
  useApp.getState().setQuality(next)
}

export interface QualityManagerProps {
  /** Upper bound for lodSplatCount (rung 0). */
  maxLodSplatCount?: number
}

/**
 * Mount once inside the Canvas (HyperspaceCanvas does this). Mirrors the persisted
 * `settings.qualityTier` into `useApp.quality.tier`, pins a manual tier, and otherwise
 * walks the ladder from drei PerformanceMonitor callbacks.
 */
export function QualityManager({ maxLodSplatCount = LOD_SPLAT_MAX }: QualityManagerProps) {
  const settingsTier = useWorld((s) => s.settings?.qualityTier)
  const tier = useApp((s) => s.quality.tier)
  const ladderRef = useRef<QualitySettings[]>([])
  const st = useRef({ rung: 0, lastChange: 0, lastClimb: -Infinity, climbCooldown: CLIMB_COOLDOWN_MS, inclines: 0 })

  // Persisted setting → runtime tier (the HUD and devApi may also set the runtime tier directly).
  useEffect(() => {
    if (settingsTier && settingsTier !== useApp.getState().quality.tier) useApp.getState().setQuality({ tier: settingsTier })
  }, [settingsTier])

  useEffect(() => {
    ladderRef.current = buildQualityLadder(maxLodSplatCount)
    const s = st.current
    s.rung = 0
    s.inclines = 0
    s.climbCooldown = CLIMB_COOLDOWN_MS
    s.lastChange = performance.now()
    applySettings(tier === 'auto' ? ladderRef.current[0] : TIER_PRESETS[tier])
  }, [tier, maxLodSplatCount])

  const onDecline = useCallback(() => {
    if (useApp.getState().quality.tier !== 'auto') return
    const s = st.current
    const now = performance.now()
    s.inclines = 0
    if (now - s.lastChange < DECLINE_COOLDOWN_MS) return
    const ladder = ladderRef.current
    if (s.rung >= ladder.length - 1) return
    if (now - s.lastClimb < FAILED_CLIMB_WINDOW_MS) {
      s.climbCooldown = Math.min(CLIMB_COOLDOWN_MAX_MS, s.climbCooldown * 2)
    }
    s.rung++
    s.lastChange = now
    applySettings(ladder[s.rung])
  }, [])

  const onIncline = useCallback(() => {
    if (useApp.getState().quality.tier !== 'auto') return
    const s = st.current
    const now = performance.now()
    if (s.rung === 0) return
    // A climb that held for a long while earns back some patience.
    if (now - s.lastClimb > 4 * FAILED_CLIMB_WINDOW_MS) s.climbCooldown = Math.max(CLIMB_COOLDOWN_MS, s.climbCooldown / 2)
    s.inclines++
    if (s.inclines < INCLINES_TO_CLIMB || now - s.lastChange < s.climbCooldown) return
    s.inclines = 0
    s.rung--
    s.lastChange = now
    s.lastClimb = now
    applySettings(ladderRef.current[s.rung])
  }, [])

  return createElement(PerformanceMonitor, {
    ms: 250,
    iterations: 8,
    threshold: 0.75,
    bounds: qualityBounds,
    onDecline,
    onIncline,
  })
}
