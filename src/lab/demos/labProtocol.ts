import type { ArrowOptions, ArrowProgress, ArrowResult, GrowthOptions, GrowthResult, LabConfig } from './labSim.ts'

// Messages between the #/lab page and its worker (labWorker.ts → LabHost). One worker
// runs the live world (play / reverse / flip / home); a second runs the long jobs (the
// arrow-of-time experiment and the growth-rate fit) so the live view never stalls.

export type ToLab =
  | { type: 'init'; cfg?: LabConfig }
  /** Sim seconds per wall second; 0 pauses, negative runs Φ⁻¹. */
  | { type: 'speed'; speed: number }
  | { type: 'flip' }
  /** Run (animated) back to the canonical origin, un-flip, and compare hashes. */
  | { type: 'home' }
  /** 1-LSB nudge of particle 0 along x. */
  | { type: 'perturb' }
  | { type: 'job'; job: 'arrow'; options?: Partial<Omit<ArrowOptions, 'cfg'>> & { cfg?: LabConfig } }
  | { type: 'job'; job: 'growth'; options?: Partial<Omit<GrowthOptions, 'cfg'>> & { cfg?: LabConfig } }
  | { type: 'cancel' }

export type LabEventKind = 'reset' | 'flip' | 'perturb' | 'home' | 'reverse' | 'forward'

export type FromLab =
  | { type: 'ready'; n: number; h0: string; s0: number; cfg: LabConfig }
  | {
      type: 'frame'
      positions: Float32Array
      /** Canonical step (state = F^flipped Φⁿ x₀) and the total steps executed. */
      n: number
      steps: number
      flipped: boolean
      perturbed: boolean
      speed: number
      homing: boolean
      hash: string
    }
  /** S at ≤ 4 Hz: `steps` is the dynamics run so far (the plot's x), `n` the canonical step. */
  | { type: 'entropy'; steps: number; n: number; S: number }
  | { type: 'event'; kind: LabEventKind; steps: number; n: number }
  | { type: 'home'; identical: boolean; hash: string; h0: string; perturbed: boolean; steps: number }
  | { type: 'progress'; job: 'arrow' | 'growth'; progress: ArrowProgress }
  | { type: 'result'; job: 'arrow'; result: ArrowResult }
  | { type: 'result'; job: 'growth'; result: GrowthResult }
  | { type: 'error'; message: string }
