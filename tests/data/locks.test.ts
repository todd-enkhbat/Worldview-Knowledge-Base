import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type NodeRecord } from '../../src/domain/types.ts'
import {
  CHANNEL_NAME,
  ReadOnlyError,
  createSync,
  createWriterLock,
  initWriterLock,
  isWriter,
  onWriterChange,
  parseChange,
  resetWriterLock,
  withSync,
} from '../../src/data/locks.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import type { StoreChange } from '../../src/data/WorldStore.ts'

// Minimal exclusive-mode LockManager: one holder per name, FIFO queue, ifAvailable and signal.
class FakeLocks {
  private held = new Set<string>()
  private queues = new Map<string, (() => void)[]>()

  request(name: string, optsOrCb: LockOptions | LockGrantedCallback<unknown>, maybeCb?: LockGrantedCallback<unknown>): Promise<unknown> {
    const opts: LockOptions = typeof optsOrCb === 'function' ? {} : optsOrCb
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb)!
    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.add(name)
        Promise.resolve()
          .then(() => cb({ name, mode: 'exclusive' } as Lock))
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name)
            this.queues.get(name)?.shift()?.()
          })
      }
      if (!this.held.has(name)) return run()
      if (opts.ifAvailable) return void Promise.resolve().then(() => cb(null)).then(resolve, reject)
      const q = this.queues.get(name) ?? []
      this.queues.set(name, q)
      if (opts.signal) {
        if (opts.signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
        opts.signal.addEventListener('abort', () => {
          const i = q.indexOf(run)
          if (i >= 0) q.splice(i, 1)
          reject(new DOMException('aborted', 'AbortError'))
        })
      }
      q.push(run)
    })
  }
  query() {
    return Promise.resolve({ held: [], pending: [] })
  }
}

const asLocks = (f: FakeLocks) => f as unknown as LockManager
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('writer lock', () => {
  afterEach(() => resetWriterLock())

  it('first tab writes, second is read-only and takes over when the first releases', async () => {
    const locks = new FakeLocks()
    const a = createWriterLock({ locks: asLocks(locks) })
    expect(await a.ready).toBe(true)
    expect(a.isWriter).toBe(true)
    expect(a.supported).toBe(true)

    const b = createWriterLock({ locks: asLocks(locks) })
    const seen: boolean[] = []
    b.onChange((w) => seen.push(w))
    expect(await b.ready).toBe(false)
    expect(b.isWriter).toBe(false)

    const aSeen: boolean[] = []
    a.onChange((w) => aSeen.push(w))
    a.release()
    await tick()
    expect(a.isWriter).toBe(false)
    expect(aSeen).toEqual([false])
    expect(b.isWriter).toBe(true)
    expect(seen).toEqual([true])

    // A third tab queues behind b; releasing it while queued is clean.
    const c = createWriterLock({ locks: asLocks(locks) })
    expect(await c.ready).toBe(false)
    c.release()
    await tick()
    expect(c.isWriter).toBe(false)
    b.release()
    await tick()
    expect(c.isWriter).toBe(false)
  })

  it('assumes a single tab when Web Locks are missing or broken', async () => {
    const none = createWriterLock({ locks: null })
    expect(none.supported).toBe(false)
    expect(none.isWriter).toBe(true)
    expect(await none.ready).toBe(true)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { request: () => Promise.reject(new DOMException('opaque origin', 'SecurityError')) }
    const b = createWriterLock({ locks: broken as unknown as LockManager })
    expect(await b.ready).toBe(true)
    expect(b.isWriter).toBe(true)
    warn.mockRestore()
  })

  it('exposes a page-wide isWriter()/onWriterChange()', async () => {
    const locks = new FakeLocks()
    const other = createWriterLock({ locks: asLocks(locks) })
    await other.ready
    expect(isWriter()).toBe(false)
    const changes: boolean[] = []
    onWriterChange((w) => changes.push(w))
    const page = initWriterLock({ locks: asLocks(locks) })
    expect(initWriterLock()).toBe(page)
    expect(await page.ready).toBe(false)
    expect(isWriter()).toBe(false)
    other.release()
    await tick()
    expect(isWriter()).toBe(true)
    expect(changes).toEqual([true])
  })
})

describe('BroadcastChannel sync', () => {
  const opened: { close(): void }[] = []
  afterEach(() => {
    for (const c of opened.splice(0)) c.close()
  })

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  }

  it('delivers changes to other tabs, not back to the sender', async () => {
    const name = `${CHANNEL_NAME}-${crypto.randomUUID()}`
    const gotA: StoreChange[] = []
    const gotB: StoreChange[] = []
    const a = createSync({ name, onChange: (c) => gotA.push(c) })
    const b = createSync({ name, onChange: (c) => gotB.push(c) })
    opened.push(a, b)
    expect(a.available).toBe(true)
    a.post({ type: 'nodes', ids: ['x', 'y'] })
    a.post({ type: 'wipe' })
    await until(() => gotB.length === 2)
    expect(gotB).toEqual([{ type: 'nodes', ids: ['x', 'y'] }, { type: 'wipe' }])
    expect(gotA).toEqual([])
  })

  it('ignores malformed messages', async () => {
    const name = `${CHANNEL_NAME}-${crypto.randomUUID()}`
    const got: StoreChange[] = []
    const b = createSync({ name, onChange: (c) => got.push(c) })
    const raw = new BroadcastChannel(name)
    opened.push(b, raw)
    raw.postMessage('hello')
    raw.postMessage({ v: 2, from: 'x', change: { type: 'wipe' } })
    raw.postMessage({ v: 1, from: 'x', change: { type: 'nodes' } })
    raw.postMessage({ v: 1, from: 'x', change: { type: 'explode' } })
    raw.postMessage({ v: 1, from: 'x', change: { type: 'settings' } })
    await until(() => got.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual([{ type: 'settings' }])
    expect(parseChange({ v: 1, change: { type: 'assets', ids: [1] } })).toBeNull()
  })

  it('degrades to a no-op without BroadcastChannel', () => {
    const s = createSync({ onChange: () => {}, BroadcastChannel: null })
    expect(s.available).toBe(false)
    s.post({ type: 'settings' })
    s.close()
  })
})

describe('withSync', () => {
  const rec = (id: string): NodeRecord => ({
    id,
    slug: id,
    archetype: 'idea',
    title: id,
    contentMd: '',
    tags: [],
    temporalOrigin: 0,
    temporalPrecision: 'day',
    referenceDate: null,
    thermo: { mass: 1, temperature: 0.5 },
    anchorXZ: [30, 0],
    links: [],
    attachments: [],
    visibility: 'private',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
  })

  it('announces committed writes with the matching StoreChange', async () => {
    const posted: StoreChange[] = []
    const s = withSync(createMemoryStore(), { sync: { post: (c) => posted.push(c) } })
    await s.putNode(rec('a'))
    await s.putNodes([rec('b'), rec('c')])
    await s.deleteNode('a')
    await s.appendEvent({ id: 'e', t: 1, kind: 'inspect', nodeId: 'b' })
    await s.clearEvents()
    await s.putBlob({ meta: { id: 'x', kind: 'text', mime: 'text/plain', bytes: 1, createdAt: 0, nodeId: null }, data: new Uint8Array([1]) })
    await s.deleteBlob('x')
    await s.putKv('k', 1)
    await s.wipe()
    expect(posted).toEqual([
      { type: 'nodes', ids: ['a'] },
      { type: 'nodes', ids: ['b', 'c'] },
      { type: 'nodes', ids: ['a'] },
      { type: 'events' },
      { type: 'events' },
      { type: 'assets', ids: ['x'] },
      { type: 'assets', ids: ['x'] },
      { type: 'wipe' },
    ])
    expect(s.info.kind).toBe('memory')
  })

  it('refuses writes in a read-only tab and announces nothing on failure', async () => {
    const posted: StoreChange[] = []
    const inner = createMemoryStore()
    let writable = false
    const s = withSync(inner, { sync: { post: (c) => posted.push(c) }, canWrite: () => writable })
    await expect(s.putNode(rec('a'))).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(s.wipe()).rejects.toBeInstanceOf(ReadOnlyError)
    expect(await s.listNodes()).toEqual([])
    writable = true
    await expect(s.putNode({ ...rec('a'), id: undefined } as unknown as NodeRecord)).rejects.toThrow()
    expect(posted).toEqual([])
    await s.putNode(rec('a'))
    expect(posted).toEqual([{ type: 'nodes', ids: ['a'] }])
  })
})
