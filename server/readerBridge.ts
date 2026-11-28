import { randomUUID } from 'node:crypto'

export const readerOperations = new Set(['identify', 'page', 'profile', 'people', 'collect', 'form', 'save-page'])
type Command = { id: string; operation: string; args: Record<string, unknown> }
type Pending = { client: string; command: Command; finish: (value: unknown, error?: string) => void }
type Summon = { client: string; ref: { id: string; url: string; documentId: string }; at: number }

/** Memory-only RPC. No page context, command, or reply enters the database. */
export class ReaderBridge {
  private connected = new Map<string, number>()
  private polls = new Map<string, { deliver: (command: Command | null) => void }>()
  private pending = new Map<string, Pending>()
  private nextSummon: Summon | null = null
  private summonWaiter: ((value: Summon | null) => void) | null = null

  summon(client: string, ref: unknown) {
    const value = ref as Summon['ref'] | null
    if (!value || typeof value.id !== 'string' || !/^\d+$/.test(value.id) || typeof value.documentId !== 'string' || !value.documentId || typeof value.url !== 'string' || !/^https?:\/\//.test(value.url)) throw Error('Choose a browser document for Enki.')
    this.connected.set(client, Date.now())
    this.nextSummon = { client, ref: { id: value.id, url: value.url, documentId: value.documentId }, at: Date.now() }
    if (this.summonWaiter) { const next = this.nextSummon; this.nextSummon = null; this.summonWaiter(next) }
    return { ok: true }
  }

  waitForSummon(signal: AbortSignal): Promise<Summon | null> {
    if (this.nextSummon && Date.now() - this.nextSummon.at < 5000) {
      const next = this.nextSummon; this.nextSummon = null; return Promise.resolve(next)
    }
    this.nextSummon = null
    this.summonWaiter?.(null)
    return new Promise(resolve => {
      const finish = (value: Summon | null) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        if (this.summonWaiter === finish) this.summonWaiter = null
        resolve(value)
      }
      const abort = () => finish(null), timer = setTimeout(abort, 20_000)
      timer.unref?.()
      if (signal.aborted) { finish(null); return }
      this.summonWaiter = finish; signal.addEventListener('abort', abort, { once: true })
    })
  }

  poll(client: string, signal: AbortSignal): Promise<Command | null> {
    this.connected.set(client, Date.now())
    // A worker restart replaces its previous long poll without duplicating work.
    this.polls.get(client)?.deliver(null)
    return new Promise(resolve => {
      const finish = (command: Command | null) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (this.polls.get(client)?.deliver === finish) this.polls.delete(client)
        resolve(command)
      }
      const abort = () => finish(null)
      const timer = setTimeout(abort, 20_000)
      timer.unref?.()
      if (signal.aborted) { finish(null); return }
      signal.addEventListener('abort', abort, { once: true })
      this.polls.set(client, { deliver: finish })
      const queued = [...this.pending.values()].find(row => row.client === client)
      if (queued) finish(queued.command)
    })
  }

  async request(operation: string, args: Record<string, unknown>, client?: string, signal?: AbortSignal) {
    if (!readerOperations.has(operation)) throw Error('Choose a supported Enki browser action.')
    const clients = [...this.connected].filter(([, seen]) => Date.now() - seen < 75_000).map(([id]) => id)
    const target = client || (clients.length === 1 ? clients[0] : undefined)
    if (!target || !clients.includes(target)) throw Error(clients.length > 1 && !client
      ? 'More than one browser is connected to Enki. Disable Enki in the other browser, then try again.'
      : 'Open Worldview Reader in Dia and enable “Connect Enki to Dia”, then press ]]] again.')
    if (this.pending.size >= 16) throw Error('Finish the current browser action first.')
    const id = randomUUID(), command = { id, operation, args }
    const value = await new Promise<unknown>((resolve, reject) => {
      const abort = () => finish(undefined, 'Enki closed this browser request.')
      const timer = setTimeout(() => finish(undefined, 'Dia did not respond. Open Worldview Reader in Dia and try again.'), 60_000)
      timer.unref?.()
      const finish = (reply: unknown, error?: string) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
        if (error) reject(Error(error)); else resolve(reply)
      }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { client: target, command, finish })
      this.polls.get(target)?.deliver(command)
    })
    return { client: target, value }
  }

  reply(client: string, input: Record<string, unknown>) {
    const pending = this.pending.get(String(input.id))
    if (!pending || pending.client !== client) throw Error('This Enki browser request expired.')
    this.connected.set(client, Date.now())
    pending.finish(input.value, typeof input.error === 'string' ? input.error.slice(0, 500) : undefined)
    return { ok: true }
  }

  disconnect(client: string) {
    if (this.nextSummon?.client === client) this.nextSummon = null
    this.connected.delete(client)
    this.polls.get(client)?.deliver(null)
    for (const row of this.pending.values()) if (row.client === client) row.finish(undefined, 'The browser connection was revoked.')
  }
}
