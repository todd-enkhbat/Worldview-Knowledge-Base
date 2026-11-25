// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { crmCommand, useCrmQuery } from '../../src/crm/client.ts'
const scope = vi.hoisted(() => ({ store: {}, generation: 1, ready: true, writer: true, listeners: new Set<(change: { type: string }) => void>() }))
vi.mock('../../src/data/repo.ts', () => ({ isRepoReady: () => scope.ready, getStore: () => scope.store, getWorldGeneration: () => scope.generation, subscribeRepo: (listener: (change: { type: string }) => void) => { scope.listeners.add(listener); return () => scope.listeners.delete(listener) }, useRepoStatus: { getState: () => ({ writer: scope.writer }) } }))
const fetcher = vi.fn<typeof fetch>(), result = (revision = 1) => ({ ok: true, operation: 'create', revision }), response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status }), input = { operation: 'create', collection: 'people' as const, record: { fullName: 'Ada' } }
let root: Root | undefined, host: HTMLDivElement | undefined
beforeEach(() => { scope.generation++; scope.store = {}; scope.ready = true; scope.writer = true; for (const listener of scope.listeners) listener({ type: 'import' }); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('crypto', webcrypto) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; host = undefined; vi.unstubAllGlobals() })
const requestIds = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).requestId as string)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('scoped CRM command retry identity', () => {
  it('reuses the request receipt after a lost committed response and does not create twice', async () => {
    const receipts = new Map<string, unknown>(); let committed = 0, lost = true
    fetcher.mockImplementation(async (_url, init) => { const command = JSON.parse(String(init!.body)); if (!receipts.has(command.requestId)) { committed++; receipts.set(command.requestId, result()) } if (lost) { lost = false; throw new TypeError('Response lost after commit') } return response(receipts.get(command.requestId)) })
    await expect(crmCommand(input)).rejects.toThrow('Response lost')
    await expect(crmCommand(input)).resolves.toMatchObject({ ok: true })
    expect(new Set(requestIds()).size).toBe(1); expect(committed).toBe(1)
  })
  it('coalesces concurrent identical command flights', async () => {
    let finish!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = crmCommand(input), second = crmCommand(input)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    finish(response(result())); await Promise.all([first, second]); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([503, 408])('retains a retry identity after an uncertain HTTP %s', async status => {
    fetcher.mockResolvedValueOnce(response({ error: 'Uncertain server result' }, status)).mockResolvedValueOnce(response(result()))
    await expect(crmCommand(input)).rejects.toThrow('Uncertain'); await crmCommand(input)
    expect(requestIds()[0]).toBe(requestIds()[1])
  })
  it('retains a retry identity after malformed successful JSON but releases definite rejections', async () => {
    fetcher.mockResolvedValueOnce(new Response('broken-json', { status: 200 })).mockResolvedValueOnce(response(result())).mockResolvedValueOnce(response({ error: 'Invalid input' }, 400)).mockResolvedValueOnce(response(result()))
    await expect(crmCommand(input)).rejects.toThrow(); await crmCommand(input)
    await expect(crmCommand(input)).rejects.toThrow('Invalid input'); await crmCommand(input)
    const ids = requestIds(); expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[3])
  })
  it('uses fresh identities for later successful actions and preserves explicit caller identities', async () => {
    fetcher.mockImplementation(async () => response(result()))
    await crmCommand(input); await crmCommand(input); expect(requestIds()[0]).not.toBe(requestIds()[1])
    await crmCommand({ ...input, requestId: 'caller-stable-id' }); expect(requestIds().at(-1)).toBe('caller-stable-id')
  })
  it('clears uncertain identities on workspace replacement and refuses stale/read-only writes', async () => {
    fetcher.mockRejectedValueOnce(new TypeError('Uncertain')).mockResolvedValueOnce(response(result()))
    await expect(crmCommand(input)).rejects.toThrow('Uncertain'); scope.generation++; for (const listener of scope.listeners) listener({ type: 'wipe' }); await crmCommand(input)
    expect(requestIds()[0]).not.toBe(requestIds()[1]); scope.writer = false; await expect(crmCommand(input)).rejects.toThrow('read only'); expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

it('never shows or edits the previous record while the query path changes', async () => {
  let next!: (response: Response) => void
  fetcher.mockResolvedValueOnce(response({ name: 'First person' })).mockImplementationOnce(() => new Promise(resolve => { next = resolve }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  function View({ path }: { path: string }) { const query = useCrmQuery<{ name: string } | null>(path, null); return <output>{query.data?.name ?? 'Waiting'}</output> }
  await act(async () => root!.render(<View path="people/first" />)); expect(host.textContent).toBe('First person')
  await act(async () => root!.render(<View path="people/second" />)); expect(host.textContent).toBe('Waiting')
  await act(async () => next(response({ name: 'Second person' }))); expect(host.textContent).toBe('Second person')
})
