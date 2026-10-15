// Persists checkpoints into a key-value store (the WorldStore kv: pass getStore() from
// src/data/repo.ts). It is a derived cache, safe to drop at any time.
//
// Keys are checkpointKey(recordsHashAt(w, step), settingsHashOf(w), step), so a checkpoint
// survives edits of records born after it and is never found again after an edit that
// affects it or a PHYSICS_VERSION bump. Values are stored by record id, not slot, because
// slot assignment depends on load order; hydrate maps ids back to the current slots.
// No DOM or data-layer imports: the store is passed in structurally.

import { type CheckpointState, type Checkpoints, checkpointKey } from './clock.ts'
import { type PhysicsWorld, recordsHashAt, settingsHashOf, slotSeed } from './world.ts'

export interface KvStore {
  getKv<T = unknown>(key: string): Promise<T | undefined>
  putKv(key: string, value: unknown): Promise<void>
  deleteKv(key: string): Promise<void>
}

export interface PersistedCheckpoint {
  readonly v: 1
  readonly step: number
  /** Record id per stored particle, in the order of x/d. */
  readonly ids: string[]
  readonly x: Int32Array
  readonly d: Int32Array
}

export const CHECKPOINT_INDEX_KEY = 'physics/ckpt/index'

export interface CheckpointCacheOptions {
  /** Most recently written entries kept; older ones are deleted. Default 256. */
  maxEntries?: number
}

export class CheckpointCache {
  readonly kv: KvStore
  readonly maxEntries: number
  /** Serialises writes so the index stays consistent. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(kv: KvStore, opts: CheckpointCacheOptions = {}) {
    this.kv = kv
    this.maxEntries = opts.maxEntries ?? 256
  }

  keyFor(w: PhysicsWorld, step: number): string {
    return checkpointKey(recordsHashAt(w, step), settingsHashOf(w), step)
  }

  /**
   * Write the in-memory checkpoint at `step`. The key and ids are captured
   * synchronously, so later edits of w cannot leak into this write. False if there is
   * no such checkpoint or its slots no longer belong to the same records.
   */
  persist(w: PhysicsWorld, ckpts: Checkpoints, step: number): Promise<boolean> {
    const st = ckpts.get(step)
    if (!st) return Promise.resolve(false)
    const ids: string[] = []
    for (let k = 0; k < st.slots.length; k++) {
      const s = st.slots[k]
      const id = w.idOf[s]
      if (id === null || slotSeed(w, s) !== st.seeds[k] || w.birth[s] > step) return Promise.resolve(false)
      ids.push(id)
    }
    const key = this.keyFor(w, step)
    const value: PersistedCheckpoint = { v: 1, step, ids, x: st.x, d: st.d }
    return this.enqueue(async () => {
      await this.kv.putKv(key, value)
      await this.touchIndex(key)
      return true
    })
  }

  /**
   * Load the cached checkpoint for (current records, settings, step) into ckpts.
   * False when absent, when w changed during the read, or when the stored ids do not
   * match A(step) exactly.
   */
  async hydrate(w: PhysicsWorld, ckpts: Checkpoints, step: number): Promise<boolean> {
    const key = this.keyFor(w, step)
    const v = await this.kv.getKv<PersistedCheckpoint>(key)
    if (!v || v.v !== 1 || v.step !== step || this.keyFor(w, step) !== key) return false
    const n = v.ids.length
    if (v.x.length !== 3 * n || v.d.length !== 3 * n) return false
    let expected = 0
    for (let s = 0; s < w.birth.length; s++) if (w.birth[s] <= step) expected++
    if (expected !== n) return false
    const order: { slot: number; k: number }[] = []
    for (let k = 0; k < n; k++) {
      const slot = w.slotOf.get(v.ids[k])
      if (slot === undefined || w.birth[slot] > step) return false
      order.push({ slot, k })
    }
    order.sort((a, b) => a.slot - b.slot)
    const slots = new Int32Array(n)
    const seeds = new Int32Array(n)
    const x = new Int32Array(3 * n)
    const d = new Int32Array(3 * n)
    for (let j = 0; j < n; j++) {
      const { slot, k } = order[j]
      if (j > 0 && slot === slots[j - 1]) return false
      slots[j] = slot
      seeds[j] = slotSeed(w, slot)
      x.set(v.x.subarray(3 * k, 3 * k + 3), 3 * j)
      d.set(v.d.subarray(3 * k, 3 * k + 3), 3 * j)
    }
    const state: CheckpointState = { step, slots, seeds, x, d }
    ckpts.put(state)
    return true
  }

  /** Hydrate every multiple of ckpts.every in [0, upTo]; returns how many were found. */
  async hydrateUpTo(w: PhysicsWorld, ckpts: Checkpoints, upTo: number): Promise<number> {
    let found = 0
    for (let step = 0; step <= upTo; step += ckpts.every) {
      if (ckpts.has(step)) continue
      if (await this.hydrate(w, ckpts, step)) found++
    }
    return found
  }

  /** Delete every cached checkpoint this cache knows of. */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      const index = (await this.kv.getKv<string[]>(CHECKPOINT_INDEX_KEY)) ?? []
      for (const key of index) await this.kv.deleteKv(key)
      await this.kv.deleteKv(CHECKPOINT_INDEX_KEY)
    })
  }

  private async touchIndex(key: string): Promise<void> {
    const index = ((await this.kv.getKv<string[]>(CHECKPOINT_INDEX_KEY)) ?? []).filter((k) => k !== key)
    index.push(key)
    const evict = index.length > this.maxEntries ? index.splice(0, index.length - this.maxEntries) : []
    for (const k of evict) await this.kv.deleteKv(k)
    await this.kv.putKv(CHECKPOINT_INDEX_KEY, index)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }
}
