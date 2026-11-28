import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
const { createReaderSummons } = createRequire(import.meta.url)('../../electron/reader-summons.cjs')

it('opens a fresh browser summon in its exact workspace and aborts its wait when stopped', async () => {
  const state = { ready: true, origin: 'http://127.0.0.1:5173', workspace: '/vault/example' }
  const summon = { client: 'dia', at: Date.now(), ref: { id: '17', url: 'https://example.org/', documentId: 'document' } }
  const fetcher = vi.fn(async () => Response.json({ summon }))
  const show = vi.fn(async () => control.stop())
  const control = createReaderSummons({ context: () => state, show, fetcher })
  control.start()
  await vi.waitFor(() => expect(show).toHaveBeenCalledWith(summon))
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(state.origin + '/api/reading-capture/enki/summons')
  expect(options.headers).toMatchObject({ 'x-wv-workspace-fingerprint': createHash('sha256').update(state.workspace).digest('hex') })
  expect(options.signal?.aborted).toBe(true)
})

it('discards a summon that arrives after changing workspaces', async () => {
  const state = { ready: true, origin: 'http://127.0.0.1:5173', workspace: '/vault/first' }
  let respond!: (value: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { respond = resolve }))
  const show = vi.fn(), control = createReaderSummons({ context: () => ({ ...state }), show, fetcher })
  control.start(); state.workspace = '/vault/second'
  respond(Response.json({ summon: { at: Date.now() } }))
  await Promise.resolve(); await Promise.resolve()
  control.stop()
  expect(show).not.toHaveBeenCalled()
})
