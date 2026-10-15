import type { InteractionEvent, WorldSettings } from '../domain/types.ts'
import type { StoreChange, WorldStore } from './WorldStore.ts'

// Multi-tab safety (PLAN § Durability → Concurrency). One tab holds the Web Lock
// 'hyperspace-writer' for its whole lifetime and is the only writer; other tabs are
// read-only and queue for the lock, so the next tab in line takes over the moment the
// writer closes. Every write is announced on BroadcastChannel('hyperspace') so readers
// refresh. Without Web Locks or BroadcastChannel we assume a single tab: writer, no sync.

export const WRITER_LOCK_NAME = 'hyperspace-writer'
export const CHANNEL_NAME = 'hyperspace'

type WriterListener = (writer: boolean) => void

export interface WriterLock {
  readonly isWriter: boolean
  /** False when navigator.locks is missing and single-tab writing is assumed. */
  readonly supported: boolean
  /** Settles once the first attempt is decided: true = writer now, false = read-only and queued. */
  readonly ready: Promise<boolean>
  onChange(cb: WriterListener): () => void
  /** Give up the lock (or the queued request). Tests and page teardown only. */
  release(): void
}

export interface WriterLockOptions {
  /** Defaults to navigator.locks; null forces the single-tab fallback. */
  locks?: LockManager | null
  name?: string
}

function defaultLocks(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
    ? navigator.locks
    : null
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

export function createWriterLock(opts: WriterLockOptions = {}): WriterLock {
  const locks = opts.locks === undefined ? defaultLocks() : opts.locks
  const name = opts.name ?? WRITER_LOCK_NAME
  const listeners = new Set<WriterListener>()
  let writer = false
  let released = false

  const set = (v: boolean) => {
    if (writer === v) return
    writer = v
    for (const cb of [...listeners]) cb(v)
  }

  // Resolved only by release(): holding the lock callback open holds the lock for the page's life.
  let releaseHold!: () => void
  const hold = new Promise<void>((resolve) => (releaseHold = resolve))
  const queueAbort = new AbortController()

  const holdLock = async () => {
    set(true)
    await hold
    set(false)
  }

  let ready: Promise<boolean>
  if (!locks) {
    writer = true
    ready = Promise.resolve(true)
  } else {
    ready = new Promise<boolean>((resolveReady) => {
      locks
        .request(name, { ifAvailable: true }, async (lock) => {
          if (released) return resolveReady(false)
          if (lock) {
            resolveReady(true)
            return holdLock()
          }
          resolveReady(false)
          // Read-only for now: wait in the lock queue and take over when the holder releases.
          locks
            .request(name, { signal: queueAbort.signal }, async () => {
              if (released) return
              return holdLock()
            })
            .catch((e: unknown) => {
              if (!isAbort(e)) console.warn('[locks] queued writer request failed', e)
            })
        })
        .catch((e: unknown) => {
          // A broken LockManager (e.g. opaque origin) must not leave the app without a writer.
          console.warn('[locks] writer lock unavailable; assuming a single tab', e)
          set(true)
          resolveReady(true)
        })
    })
  }

  return {
    get isWriter() {
      return writer
    },
    supported: locks !== null,
    ready,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    release() {
      if (released) return
      released = true
      queueAbort.abort()
      releaseHold()
      if (!locks) set(false)
    },
  }
}

// ─── page-wide singleton ─────────────────────────────────────────────────────────────

let pageLock: WriterLock | null = null
const pageListeners = new Set<WriterListener>()

/** Acquire (or join the queue for) the writer lock for this page. Idempotent. */
export function initWriterLock(opts?: WriterLockOptions): WriterLock {
  if (pageLock) return pageLock
  const lock = createWriterLock(opts)
  pageLock = lock
  lock.onChange((w) => {
    for (const cb of [...pageListeners]) cb(w)
  })
  return lock
}

/** Whether this tab may write. False until initWriterLock has acquired the lock. */
export function isWriter(): boolean {
  return pageLock?.isWriter ?? false
}

export function onWriterChange(cb: WriterListener): () => void {
  pageListeners.add(cb)
  return () => pageListeners.delete(cb)
}

/** Test hook: release and forget the page lock. */
export function resetWriterLock(): void {
  pageLock?.release()
  pageLock = null
  pageListeners.clear()
}

// ─── BroadcastChannel sync ───────────────────────────────────────────────────────────

interface Envelope {
  v: 1
  from: string
  change: StoreChange
}

export interface SyncOptions {
  onChange: (change: StoreChange) => void
  name?: string
  /** Defaults to globalThis.BroadcastChannel; null disables cross-tab sync. */
  BroadcastChannel?: typeof BroadcastChannel | null
}

export interface Sync {
  /** False when BroadcastChannel is missing (single tab assumed). */
  readonly available: boolean
  post(change: StoreChange): void
  close(): void
}

const CHANGE_TYPES = new Set<StoreChange['type']>(['nodes', 'settings', 'events', 'assets', 'wipe', 'import'])

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** Shape-check a message from another tab (it may run older or newer code). */
export function parseChange(data: unknown): StoreChange | null {
  if (typeof data !== 'object' || data === null) return null
  const env = data as Partial<Envelope>
  const c = env.change as { type?: unknown; ids?: unknown } | undefined
  if (env.v !== 1 || !c || !CHANGE_TYPES.has(c.type as StoreChange['type'])) return null
  if ((c.type === 'nodes' || c.type === 'assets') && !isStringArray(c.ids)) return null
  return c as StoreChange
}

export function createSync(opts: SyncOptions): Sync {
  const BC = opts.BroadcastChannel === undefined ? globalThis.BroadcastChannel : opts.BroadcastChannel
  if (typeof BC !== 'function') return { available: false, post() {}, close() {} }
  const from = crypto.randomUUID()
  const ch = new BC(opts.name ?? CHANNEL_NAME)
  let closed = false
  ch.onmessage = (ev: MessageEvent) => {
    const env = ev.data as Partial<Envelope> | null
    if (env?.from === from) return
    const change = parseChange(env)
    if (change) opts.onChange(change)
  }
  return {
    available: true,
    post(change) {
      if (closed) return
      try {
        ch.postMessage({ v: 1, from, change } satisfies Envelope)
      } catch (e) {
        // Never fail a committed write because the notification could not be sent.
        console.warn('[locks] broadcast failed', e)
      }
    },
    close() {
      closed = true
      ch.close()
    },
  }
}

// ─── write guard + announce ──────────────────────────────────────────────────────────

export class ReadOnlyError extends Error {
  constructor(message = 'This tab is read-only: the world is open for editing in another tab') {
    super(message)
    this.name = 'ReadOnlyError'
  }
}

export interface SyncedStoreOptions {
  sync?: Pick<Sync, 'post'> | null
  /** Writes throw ReadOnlyError when this returns false. Default: always writable. */
  canWrite?: () => boolean
}

/**
 * Wrap a store so every write is refused in read-only tabs and announced to other tabs once
 * it has committed. kv writes are local app state and are not announced.
 */
export function withSync(store: WorldStore, opts: SyncedStoreOptions): WorldStore {
  const post = (c: StoreChange) => opts.sync?.post(c)
  const guard = () => {
    if (opts.canWrite && !opts.canWrite()) throw new ReadOnlyError()
  }
  const write =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>, change: ((...args: A) => StoreChange) | null) =>
    async (...args: A): Promise<R> => {
      guard()
      const out = await fn(...args)
      if (change) post(change(...args))
      return out
    }
  return {
    info: store.info,
    getSettings: () => store.getSettings(),
    listNodes: () => store.listNodes(),
    getNode: (id) => store.getNode(id),
    listEvents: (sinceT) => store.listEvents(sinceT),
    getBlob: (id) => store.getBlob(id),
    getAssetMeta: (id) => store.getAssetMeta(id),
    listAssets: () => store.listAssets(),
    getKv: <T = unknown>(key: string) => store.getKv<T>(key),

    putSettings: write((s: WorldSettings) => store.putSettings(s), () => ({ type: 'settings' })),
    putNode: write((n) => store.putNode(n), (n) => ({ type: 'nodes', ids: [n.id] })),
    putNodes: write((ns) => store.putNodes(ns), (ns) => ({ type: 'nodes', ids: ns.map((n) => n.id) })),
    deleteNode: write((id) => store.deleteNode(id), (id) => ({ type: 'nodes', ids: [id] })),
    appendEvent: write((e: InteractionEvent) => store.appendEvent(e), () => ({ type: 'events' })),
    clearEvents: write((beforeT?: number) => store.clearEvents(beforeT), () => ({ type: 'events' })),
    putBlob: write((input) => store.putBlob(input), (input) => ({ type: 'assets', ids: [input.meta.id] })),
    deleteBlob: write((id) => store.deleteBlob(id), (id) => ({ type: 'assets', ids: [id] })),
    putKv: write((key: string, value: unknown) => store.putKv(key, value), null),
    deleteKv: write((key: string) => store.deleteKv(key), null),
    wipe: write(() => store.wipe(), () => ({ type: 'wipe' })),
    close: () => store.close(),
  }
}
