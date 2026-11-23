import type { IncomingMessage, ServerResponse } from 'node:http'

// Live changes across devices. Every browser already announces its committed writes to its
// own other tabs (src/data/locks.ts, BroadcastChannel); with the server store it also posts
// them here, and the server relays each one to every other open device of the same world
// over Server-Sent Events. Receivers re-read the named records, exactly as for a tab.
//
//   GET  /api/world/changes?client=<id>   text/event-stream; one `data: {from, change}` per change
//   POST /api/world/changes               {from, change}

export interface ChangeEnvelope {
  v: 1
  from: string
  change: { type: string; ids?: string[]; keys?: string[] }
}

const TYPES = new Set(['nodes', 'settings', 'events', 'assets', 'kv', 'wipe', 'import'])
const MAX_IDS = 10_000
const HEARTBEAT_MS = 25_000

export function parseEnvelope(raw: unknown): ChangeEnvelope | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  const c = e.change as Record<string, unknown> | undefined
  if (typeof e.from !== 'string' || e.from.length > 100 || !c || typeof c.type !== 'string' || !TYPES.has(c.type)) return null
  if (c.type === 'nodes' || c.type === 'assets') {
    if (!Array.isArray(c.ids) || c.ids.length > MAX_IDS || !c.ids.every((i) => typeof i === 'string')) return null
    return { v: 1, from: e.from, change: { type: c.type, ids: c.ids as string[] } }
  }
  if (c.type === 'kv') {
    if (!Array.isArray(c.keys) || c.keys.length > MAX_IDS || !c.keys.every((key) => typeof key === 'string' && key.length <= 200)) return null
    return { v: 1, from: e.from, change: { type: 'kv', keys: c.keys as string[] } }
  }
  return { v: 1, from: e.from, change: { type: c.type } }
}

export class ChangeBus {
  private readonly clients = new Map<ServerResponse, string>()
  private beat: ReturnType<typeof setInterval> | null = null

  get size(): number {
    return this.clients.size
  }

  /** Hold `res` open as an event stream for `client` until the request closes. */
  subscribe(req: IncomingMessage, res: ServerResponse, client: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.set(res, client)
    this.beat ??= setInterval(() => {
      for (const r of this.clients.keys()) r.write(': beat\n\n')
    }, HEARTBEAT_MS)
    this.beat.unref?.()
    req.on('close', () => {
      this.clients.delete(res)
      if (!this.clients.size && this.beat) {
        clearInterval(this.beat)
        this.beat = null
      }
    })
  }

  /** Relay to every subscriber but the sender. Returns how many received it. */
  publish(env: ChangeEnvelope): number {
    const line = `data: ${JSON.stringify(env)}\n\n`
    let n = 0
    for (const [res, client] of this.clients) {
      if (client === env.from) continue
      res.write(line)
      n++
    }
    return n
  }

  close(): void {
    for (const res of this.clients.keys()) res.end()
    this.clients.clear()
    if (this.beat) clearInterval(this.beat)
    this.beat = null
  }
}
