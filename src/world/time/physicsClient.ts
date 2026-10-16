import { create } from 'zustand'
import { useApp, useWorld } from '../../app/store.ts'
import type { FromWorker, SimStats, SlotTable, ToWorker } from '../../physics/workerProtocol.ts'
import { ensurePlayhead } from './clock.ts'
import { type Mirror, diffRecords, mirrorAll, settingsKey } from './records.ts'

// Main-thread side of the physics worker. It mirrors useWorld's live records into the
// worker (a full `load` when the settings change, otherwise `edit` diffs by updatedAt),
// forwards the playhead's target step, and keeps the newest frame. Frames arrive as
// freshly transferred buffers, so the double buffer is two references: `pending` (newest
// arrived) and `front` (being rendered this frame); acquire() swaps them once per frame.

export type PhysicsMode = 'starting' | 'physics' | 'static'

export interface SimStatsState {
  /** starting: no frame yet · physics: worker frames · static: anchors only (no worker). */
  mode: PhysicsMode
  stats: SimStats | null
  /** Last worker error (a fatal one also switches mode to 'static'). */
  error: string | null
}

/** Worker stats for the HUD; updated only when a value changes, never per frame. */
export const useSimStats = create<SimStatsState>()(() => ({ mode: 'starting', stats: null, error: null }))

export interface PhysicsFrame {
  readonly gen: number
  readonly step: number
  /** X at frac 0, xyz per slot (world units). */
  readonly pos: Float32Array
  /** D per slot in world units per step. */
  readonly vel: Float32Array
  /** Active at `step`. */
  readonly born: Uint8Array
  /** The slot layout in effect for this frame. */
  readonly slots: SlotTable
}

/** The Worker surface the client uses (tests pass a fake). */
export interface WorkerLike {
  postMessage(msg: ToWorker): void
  terminate(): void
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

function sameStats(a: SimStats | null, b: SimStats): boolean {
  if (!a) return false
  const ea = a.energy
  const eb = b.energy
  return (
    a.activeCount === b.activeCount &&
    a.S === b.S &&
    a.checkpoints === b.checkpoints &&
    a.settling === b.settling &&
    a.overflowSentinel === b.overflowSentinel &&
    (ea === eb || (ea !== null && eb !== null && ea.ledger === eb.ledger && ea.raw === eb.raw && ea.origin === eb.origin))
  )
}

export function spawnPhysicsWorker(): WorkerLike {
  return new Worker(new URL('../../physics/worker.ts', import.meta.url), { type: 'module', name: 'physics' })
}

export class PhysicsClient {
  private readonly spawn: () => WorkerLike
  private worker: WorkerLike | null = null
  private failedFlag = false
  private gen = 0
  private mirror: Mirror = new Map()
  private key: string | null = null
  private lastTarget = Number.NaN
  private slots: SlotTable | null = null
  private front: PhysicsFrame | null = null
  private pending: PhysicsFrame | null = null
  private unsubscribe: (() => void) | null = null
  private refs = 0

  constructor(spawn: () => WorkerLike = spawnPhysicsWorker) {
    this.spawn = spawn
  }

  /** True once the worker could not be started or reported a fatal error. */
  get failed(): boolean {
    return this.failedFlag
  }

  /** Start (ref-counted, so StrictMode's mount/unmount/mount is harmless). False = static fallback. */
  start(): boolean {
    this.refs++
    if (this.worker || this.failedFlag) return !this.failedFlag
    try {
      if (typeof Worker === 'undefined' && this.spawn === spawnPhysicsWorker) throw new Error('Web Workers are unavailable')
      const w = this.spawn()
      w.onmessage = (e) => this.receive(e.data)
      w.onerror = (e) => this.fail(e.message || 'physics worker failed to start')
      this.worker = w
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
      return false
    }
    this.unsubscribe = useWorld.subscribe((s, prev) => {
      if (s.revision !== prev.revision || s.settings !== prev.settings || s.loaded !== prev.loaded) this.syncRecords()
    })
    this.syncRecords()
    return true
  }

  stop(): void {
    if (--this.refs > 0) return
    this.refs = 0
    this.unsubscribe?.()
    this.unsubscribe = null
    this.worker?.terminate()
    this.worker = null
    this.key = null
    this.mirror = new Map()
    this.front = this.pending = null
    this.slots = null
    this.lastTarget = Number.NaN
  }

  /** Bring the worker's records in line with useWorld (load on a settings change, else edits). */
  syncRecords(): void {
    const w = this.worker
    if (!w) return
    const { loaded, settings, nodes } = useWorld.getState()
    if (!loaded || !settings) return
    const key = settingsKey(settings)
    if (key !== this.key) {
      this.key = key
      this.gen++
      const { mirror, records } = mirrorAll(nodes, settings)
      this.mirror = mirror
      this.front = this.pending = null
      this.slots = null
      const target = ensurePlayhead(settings)
      this.lastTarget = target
      w.postMessage({ type: 'load', gen: this.gen, records, seed: settings.physicsSeed, settingsKey: key, target })
      return
    }
    const { mirror, diff } = diffRecords(this.mirror, nodes, settings)
    this.mirror = mirror
    if (diff.upserts.length || diff.removes.length) w.postMessage({ type: 'edit', ...diff })
  }

  /** Ask the worker for the world at `step` (only when it changed). */
  sendTarget(step: number): void {
    if (!this.worker || this.key === null || step === this.lastTarget) return
    this.lastTarget = step
    this.worker.postMessage({ type: 'target', step })
  }

  /** Drop the persistent checkpoint cache (derived data). */
  clearCache(): void {
    this.worker?.postMessage({ type: 'clear-cache' })
  }

  /** The newest complete frame of the current load, swapped in once per render frame. */
  acquire(): PhysicsFrame | null {
    if (this.pending) {
      this.front = this.pending
      this.pending = null
    }
    return this.front && this.front.gen === this.gen ? this.front : null
  }

  /** Handle one worker message (public for tests). */
  receive(msg: FromWorker): void {
    if (msg.gen !== this.gen) return
    switch (msg.type) {
      case 'frame': {
        if (msg.slots) this.slots = msg.slots
        if (!this.slots) return
        this.pending = { gen: msg.gen, step: msg.step, pos: msg.pos, vel: msg.vel, born: msg.born, slots: this.slots }
        this.publish(msg.stats, 'physics')
        break
      }
      case 'stats':
        this.publish(msg.stats, this.front || this.pending ? 'physics' : 'starting')
        break
      case 'error':
        if (msg.fatal) this.fail(msg.message)
        else {
          console.warn('[physics]', msg.message)
          useSimStats.setState({ error: msg.message })
        }
        break
    }
  }

  private publish(stats: SimStats, mode: PhysicsMode): void {
    const cur = useSimStats.getState()
    if (cur.mode !== mode || !sameStats(cur.stats, stats)) useSimStats.setState({ mode, stats })
    const app = useApp.getState()
    if (app.clock.settling !== stats.settling) app.setClock({ settling: stats.settling })
  }

  private fail(message: string): void {
    console.warn('[physics] falling back to static anchors:', message)
    this.failedFlag = true
    this.worker?.terminate()
    this.worker = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.front = this.pending = null
    useSimStats.setState({ mode: 'static', error: message })
    if (useApp.getState().clock.settling) useApp.getState().setClock({ settling: false })
  }
}

let client: PhysicsClient | null = null

/** The app's one physics client. */
export function getPhysicsClient(): PhysicsClient {
  return (client ??= new PhysicsClient())
}
