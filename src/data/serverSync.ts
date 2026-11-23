import { parseChange, type Sync } from './locks.ts'
import type { StoreChange } from './WorldStore.ts'

// Live changes between devices when the world lives on the server (server/changes.ts). Same
// contract as the BroadcastChannel sync between tabs: post() announces a committed write,
// onChange() hears another device's. Each tab is one client; the server never echoes a
// client's own notices back to it. EventSource reconnects by itself after a drop, and a
// reconnect is followed by a full re-read, since notices sent meanwhile were missed.

/** This tab's id on the server (also sent as x-wv-client on every engine request). */
export const CLIENT_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)

export interface ServerSyncOptions {
  onChange: (change: StoreChange) => void
  base?: string
  fetch?: typeof fetch
  EventSource?: typeof EventSource | null
}

export function createServerSync(opts: ServerSyncOptions): Sync {
  const base = opts.base ?? '/api'
  const ES = opts.EventSource === undefined ? globalThis.EventSource : opts.EventSource
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  if (typeof ES !== 'function') return { available: false, post() {}, close() {} }
  const es = new ES(`${base}/world/changes?client=${encodeURIComponent(CLIENT_ID)}`)
  let opened = false
  let closed = false
  es.onopen = () => {
    // After a drop, notices sent while we were away are gone: re-read everything.
    if (opened) opts.onChange({ type: 'import' })
    opened = true
  }
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      const change = parseChange(JSON.parse(ev.data))
      if (change) opts.onChange(change)
    } catch {
      // not ours
    }
  }
  return {
    available: true,
    post(change) {
      if (closed) return
      void f(`${base}/world/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wv-client': CLIENT_ID },
        body: JSON.stringify({ v: 1, from: CLIENT_ID, change }),
      }).catch((e: unknown) => console.warn('[sync] could not announce a change to other devices', e))
    },
    close() {
      closed = true
      es.close()
    },
  }
}

/** Announce to every sync, hear from all of them. */
export function combineSyncs(...syncs: Sync[]): Sync {
  return {
    available: syncs.some((s) => s.available),
    post: (c) => syncs.forEach((s) => s.post(c)),
    close: () => syncs.forEach((s) => s.close()),
  }
}
