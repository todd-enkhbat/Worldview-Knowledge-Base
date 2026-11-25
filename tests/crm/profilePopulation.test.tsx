// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CrmProfilePopulation } from '../../src/crm/CrmProfilePopulation.tsx'

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../src/crm/profileMediaClient.ts', () => ({ profileMediaPost: api.post }))
vi.mock('../../src/crm/CrmControls.tsx', () => ({ CrmDialog: ({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) => <section role="dialog" aria-label={title}><button aria-label="Close dialog" onClick={onClose}>Close</button>{children}</section> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, mounted: boolean
const changed = vi.fn(), closed = vi.fn()
const result = (offset = 0, nextOffset: number | null = 5) => ({ total: 12, offset, nextOffset, results: [
  { personId: `photo_${offset}`, name: `Photo contact ${offset}`, status: 'updated', downloaded: true, addedLinks: 1 },
  { personId: `missing_${offset}`, name: `Missing contact ${offset}`, status: 'unavailable', downloaded: false, addedLinks: 0, notices: ['Needs a retained profile.'] },
], downloaded: 1, updated: 1, addedLinks: 1, cloudAiUsed: false })
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true; changed.mockReset(); closed.mockReset(); api.post.mockReset().mockResolvedValue(result()) })
afterEach(async () => { if (mounted) await act(async () => root.unmount()); host.remove() })
async function render(disabled = false, groupId?: string) { await act(async () => root.render(<CrmProfilePopulation groupId={groupId} groupName={groupId ? 'Columbia' : undefined} disabled={disabled} onClose={closed} onChanged={changed} />)) }
function button(label: string) { const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label); expect(found, label).toBeDefined(); return found! }
async function click(label: string) { await act(async () => button(label).click()) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }

it('starts only on request and processes scoped pages only after explicit continuation', async () => {
  api.post.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(5, 10)).mockResolvedValueOnce(result(10, null))
  await render(false, 'group_columbia')
  expect(host.textContent).toContain('Columbia, with a fuller picture')
  expect(api.post).not.toHaveBeenCalled()
  await click('Populate missing profiles')
  expect(api.post).toHaveBeenNthCalledWith(1, 'populate', { requestId: expect.any(String), offset: 0, limit: 5, discover: true, eligibleOnly: true, groupId: 'group_columbia' })
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('5 of 12 eligible profiles checked')
  expect(host.textContent).toContain('Photo contact 0')
  expect(host.textContent).toContain('Needs a capture or upload')
  await click('Check next five')
  expect(api.post).toHaveBeenNthCalledWith(2, 'populate', expect.objectContaining({ offset: 5, limit: 5, groupId: 'group_columbia' }))
  expect(api.post.mock.calls[1][1].requestId).not.toBe(api.post.mock.calls[0][1].requestId)
  expect(host.textContent).toContain('10 of 12 eligible profiles checked')
  await click('Check next five')
  expect(api.post).toHaveBeenNthCalledWith(3, 'populate', expect.objectContaining({ offset: 10, groupId: 'group_columbia' }))
  expect(host.textContent).toContain('12 of 12 eligible profiles checked · Finished')
  expect(host.textContent).toContain('This pass is complete.')
  expect(button('Check next five').disabled).toBe(true)
  expect(changed).toHaveBeenCalledTimes(3)
})

it('retries an uncertain batch with the identical scope, offset and request identity', async () => {
  api.post.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(result())
  await render(false, 'group_columbia'); await click('Populate missing profiles')
  expect(host.textContent).toContain('Connection interrupted')
  expect(changed).not.toHaveBeenCalled()
  const first = api.post.mock.calls[0]
  await click('Retry this batch')
  expect(api.post.mock.calls[1]).toEqual(first)
  expect(host.querySelectorAll('.crm-population-results>div')).toHaveLength(2)
  expect(host.textContent).not.toContain('Connection interrupted')
  expect(changed).toHaveBeenCalledOnce()
})

it('does not treat an incomplete receipt as progress and keeps its retry identity', async () => {
  api.post.mockResolvedValueOnce({ total: 12, nextOffset: 5 }).mockResolvedValueOnce(result())
  await render(); await click('Populate missing profiles')
  expect(host.textContent).toContain('The profile receipt was incomplete.')
  expect(host.querySelector('progress')).toBeNull()
  const first = api.post.mock.calls[0]
  await click('Retry this batch')
  expect(api.post.mock.calls[1]).toEqual(first)
  expect(first[1]).not.toHaveProperty('groupId')
  expect(changed).toHaveBeenCalledOnce()
})

it('never starts a request in a read-only window and keeps close available', async () => {
  await render(true)
  expect(button('Populate missing profiles').disabled).toBe(true)
  await click('Populate missing profiles')
  expect(api.post).not.toHaveBeenCalled()
  await click('Done')
  expect(closed).toHaveBeenCalledOnce()
})

it('coalesces a pending click and lets the current batch finish after closing without mounted callbacks', async () => {
  const pending = deferred<ReturnType<typeof result>>()
  api.post.mockReturnValueOnce(pending.promise)
  await render(); await click('Populate missing profiles')
  expect(button('Checking profiles…').disabled).toBe(true)
  await click('Checking profiles…')
  expect(api.post).toHaveBeenCalledOnce()
  await click('Close · current batch will finish')
  expect(closed).toHaveBeenCalledOnce()
  await act(async () => { root.unmount(); mounted = false })
  await act(async () => { pending.resolve(result()); await pending.promise })
  expect(changed).not.toHaveBeenCalled()
  expect(host.textContent).toBe('')
  expect(api.post).toHaveBeenCalledOnce()
})
