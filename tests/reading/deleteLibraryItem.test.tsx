// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const actions = vi.hoisted(() => ({ softDelete: vi.fn(), folder: vi.fn(), book: vi.fn(), writing: vi.fn() }))
vi.mock('../../src/data/repo.ts', () => ({ softDelete: actions.softDelete, useRepoStatus: (select: (s: { writer: boolean }) => unknown) => select({ writer: true }) }))
vi.mock('../../src/knowledge/index.ts', () => ({ useKnowledge: { getState: () => ({ sources: [{ id: 'source', nodeId: 'node' }] }) } }))
vi.mock('../../src/reading/store.ts', () => ({ deleteFolder: actions.folder }))
vi.mock('../../src/bookshelf/store.ts', () => ({ archiveBook: actions.book }))
vi.mock('../../src/writing/store.ts', () => ({ archiveWritingDocument: actions.writing }))
import { DeleteLibraryItem } from '../../src/reading/DeleteLibraryItem.tsx'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { vi.resetAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function click(label: string) { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!.click()) }
it('requires confirmation, supports cancellation, and trashes the underlying source record', async () => {
  await act(async () => root.render(<DeleteLibraryItem id="source" name="Notes" kind="source" />))
  await click('Delete Notes')
  expect(actions.softDelete).not.toHaveBeenCalled()
  await click('Cancel')
  expect(host.querySelector('dialog')).toBeNull()
  await click('Delete Notes'); await click('Move to Trash')
  expect(actions.softDelete).toHaveBeenCalledWith('node')
  expect(host.querySelector('dialog')).toBeNull()
})
it('keeps a failed deletion open with recovery text', async () => {
  actions.folder.mockRejectedValue(new Error('Rename the conflicting child page first.'))
  await act(async () => root.render(<DeleteLibraryItem id="folder" name="Reading" kind="folder" />))
  await click('Delete Reading'); await click('Delete section, keep contents')
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Rename the conflicting child')
  expect(host.querySelector('dialog')).not.toBeNull()
})
it.each(['book', 'writing'] as const)('uses the existing %s archive so the file remains restorable', async kind => {
  await act(async () => root.render(<DeleteLibraryItem id="entry" name="Draft" kind={kind} />))
  await click('Delete Draft')
  expect(host.querySelector('dialog a')?.getAttribute('href')).toBe(kind === 'book' ? '#/bookshelf?view=trash&kind=book' : '#/write?view=trash')
  expect(document.activeElement?.textContent).toBe('Cancel')
  await click('Move to Trash')
  expect(actions[kind]).toHaveBeenCalledWith('entry')
})
