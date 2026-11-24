// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import type { ReadingPdfHighlight } from '../../src/reading/types.ts'
import type { SourceVersion } from '../../src/knowledge/types.ts'
import PdfReader from '../../src/reading/PdfReader.tsx'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.resolve({ numPages: 2, getPage: async (page: number) => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [{ str: `Selectable PDF page ${page}` }] }), cleanup: vi.fn() }) }), destroy: async () => {} }),
  TextLayer: class { container: HTMLElement; text: string; constructor({ container, textContentSource }: { container: HTMLElement; textContentSource: { items: { str: string }[] } }) { this.container = container; this.text = textContentSource.items[0].str } render() { this.container.textContent = this.text; return Promise.resolve() } cancel() {} },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const version: SourceVersion = { id: 'version-pdf', sourceId: 'source-pdf', contentHash: 'content', originalBlobId: 'original-pdf', originalName: 'reading-pages.pdf', text: 'Retained original PDF text.', createdAt: 1, authoredAt: null, origin: 'import' }
const highlight: ReadingPdfHighlight = { id: 'page-one-highlight', sourceId: version.sourceId, versionId: version.id, page: 1, quote: 'copper orchard', rects: [{ x: .1, y: .1, width: .2, height: .03 }], note: 'My saved thought.', color: 'yellow', createdAt: 1, updatedAt: 1 }
let root: Root, host: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('PDF page navigation must not contact a provider') }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const bytes = new Uint8Array(readFileSync('tests/fixtures/reading-pages.pdf'))
  await getStore().putBlob({ meta: { id: version.originalBlobId, kind: 'file', mime: 'application/pdf', bytes: bytes.length, createdAt: 1, nodeId: null }, data: bytes })
  history.replaceState(null, '', `#/library?source=${version.sourceId}&version=${version.id}&page=1`)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await closeRepo(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const page = () => host.querySelector<HTMLInputElement>('input[aria-label="PDF page"]')!
const next = () => host.querySelector<HTMLButtonElement>('button[aria-label="Next PDF page"]')!
async function render(locateRequest?: number) { await act(async () => root.render(<PdfReader version={version} highlights={[highlight]} onSelect={() => {}} onHighlight={() => {}} locateId={locateRequest === undefined ? null : highlight.id} locateRequest={locateRequest} />)) }

it('returns to a saved page after internal pagination, including repeated Show context without replaying the stale URL', async () => {
  await render()
  expect(page().value).toBe('1'); expect(next().disabled).toBe(false)
  await act(async () => next().click())
  expect(page().value).toBe('2'); expect(location.hash).toContain('page=2')
  // A parent render reveals the URL written by the internal pager. The explicit
  // annotation request must win over that older page query.
  await render(1)
  expect(page().value).toBe('1'); expect(location.hash).toContain('page=1')
  await act(async () => next().click())
  expect(page().value).toBe('2')
  await render(2)
  expect(page().value).toBe('1'); expect(location.hash).toContain('page=1')
  expect(host.querySelector('[data-pdf-highlight="page-one-highlight"]')).toBeTruthy()
})

it('honors an external page deep link only for the currently open source and retained version', async () => {
  await render()
  await act(async () => { history.replaceState(null, '', `#/library?source=${version.sourceId}&version=${version.id}&page=2`); window.dispatchEvent(new HashChangeEvent('hashchange')) })
  expect(page().value).toBe('2')
  await act(async () => { history.replaceState(null, '', '#/library?source=other-source&version=other-version&page=1'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
  expect(page().value).toBe('2')
})
