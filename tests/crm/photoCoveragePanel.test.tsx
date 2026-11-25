// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhotoCoveragePanel } from '../../src/crm/PhotoCoveragePanel.tsx'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../src/crm/client.ts', () => ({ useCrmQuery: query }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const onSelect = vi.fn(), onShowMissing = vi.fn(), refresh = vi.fn()
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); HTMLDialogElement.prototype.showModal = function () { this.open = true }; HTMLDialogElement.prototype.close = function () { this.open = false }; query.mockReturnValue({ data: { total: 1389, available: 63, missing: 1326, damaged: 1, missingOriginal: 2, filteredTotal: 1326, nextOffset: 100, rows: [{ personId: 'per_one', name: 'Saved contact', status: 'missing', sources: ['LinkedIn'], reason: 'Open the saved profile in Reader.' }] }, loading: false, error: '', refresh }) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const button = (text: string) => [...document.querySelectorAll('button')].find(x => x.textContent === text)!
it('reports verified originals honestly and offers explicit contact and gallery navigation', async () => {
  await act(async () => root.render(<PhotoCoveragePanel onClose={() => {}} onSelect={onSelect} onShowMissing={onShowMissing} />))
  expect(document.body.textContent).toContain('63 of 1,389'); expect(document.body.textContent).toContain('1326 need attention'); expect(document.body.textContent).toContain('3 originals need repair')
  const progress = document.querySelector('progress')!; expect(progress.value).toBe(63); expect(progress.max).toBe(1389)
  expect(onSelect).not.toHaveBeenCalled(); await act(async () => button('Saved contactOpen the saved profile in Reader.LinkedIn').click()); expect(onSelect).toHaveBeenCalledWith('per_one')
  await act(async () => button('Show missing photos in Gallery').click()); expect(onShowMissing).toHaveBeenCalledOnce()
})
it('paginates the complete audit and resets the page when the status changes', async () => {
  await act(async () => root.render(<PhotoCoveragePanel onClose={() => {}} onSelect={onSelect} onShowMissing={onShowMissing} />))
  await act(async () => button('Next').click()); expect(query.mock.calls.at(-1)?.[0]).toContain('offset=100&status=needs-attention')
  await act(async () => { const select = document.querySelector('select')!; select.value = 'available'; select.dispatchEvent(new Event('change', { bubbles: true })) }); expect(query.mock.calls.at(-1)?.[0]).toContain('offset=0&status=available')
})
it('never displays a successful count when the audit is unavailable', async () => {
  query.mockReturnValue({ data: null, loading: false, error: 'The original check failed.', refresh }); await act(async () => root.render(<PhotoCoveragePanel onClose={() => {}} onSelect={onSelect} onShowMissing={onShowMissing} />))
  expect(document.querySelector('[role=alert]')?.textContent).toBe('The original check failed.'); expect(document.querySelector('progress')).toBeNull(); expect(document.body.textContent).not.toContain('1,389')
})
