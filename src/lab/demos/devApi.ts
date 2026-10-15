import { runJob, sendLive, useLabJobs, useLabLive } from './labClient.ts'
import type { ArrowOptions, ArrowResult, GrowthOptions, GrowthResult } from './labSim.ts'
import type { ToLab } from './labProtocol.ts'

// Dev handle for agent checks of the #/lab demos through javascript_tool (like __s2).

export interface LabDevApi {
  /** Run the arrow-of-time experiment (default 300 s) and resolve with its result. */
  arrow(options?: Partial<Omit<ArrowOptions, 'cfg'>>): Promise<ArrowResult>
  /** Run the growth-rate fit and resolve with its result. */
  growth(options?: Partial<Omit<GrowthOptions, 'cfg'>>): Promise<GrowthResult>
  /** Snapshot of the live world panel's state. */
  live(): ReturnType<typeof useLabLive.getState>
  jobs(): ReturnType<typeof useLabJobs.getState>
  /** Send a raw command to the live worker (speed, flip, home, perturb, init). */
  send(msg: ToLab): void
}

declare global {
  interface Window {
    __lab?: LabDevApi
  }
}

export function installLabDevApi(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  window.__lab = {
    arrow: (o = {}) => runJob('arrow', o),
    growth: (o = {}) => runJob('growth', o),
    live: () => useLabLive.getState(),
    jobs: () => useLabJobs.getState(),
    send: sendLive,
  }
}
