// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import type { SourceVersion } from '../../src/knowledge/types.ts'
import { isPdfVersion, pdfSelection, readPdfOriginal } from '../../src/reading/pdfModel.ts'
const version = (blobId: string): SourceVersion => ({ id: 'v', sourceId: 's', contentHash: 'h', originalBlobId: blobId, originalName: 'reading-pages.pdf', text: 'Retained extracted text.', createdAt: 0, authoredAt: null, origin: 'import' })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); window.getSelection()?.removeAllRanges() })
it('opens the exact retained PDF bytes and refuses a corrupt content-addressed original or a purged source', async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  const bytes = new Uint8Array(readFileSync('tests/fixtures/reading-pages.pdf')), store = createMemoryStore()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (part) => part.toString(16).padStart(2, '0')).join(''), id = `knowledge-${digest}`
  await store.putBlob({ meta: { id, kind: 'file', mime: 'application/pdf', bytes: bytes.length, createdAt: 0, nodeId: null }, data: bytes })
  expect(await readPdfOriginal(version(id), store)).toEqual(bytes)
  const meta = await store.getAssetMeta(id)
  vi.spyOn(store, 'getAssetMeta').mockResolvedValueOnce({ ...meta!, bytes: bytes.length + 1 })
  await expect(readPdfOriginal(version(id), store)).rejects.toThrow(/retained size/)
  const changed = bytes.slice(); changed[100] ^= 1
  await store.putBlob({ meta: { id, kind: 'file', mime: 'application/pdf', bytes: changed.length, createdAt: 0, nodeId: null }, data: changed })
  await expect(readPdfOriginal(version(id), store)).rejects.toThrow(/content check/)
  await expect(readPdfOriginal({ ...version(id), originalPurged: true }, store)).rejects.toThrow(/intentionally removed/)
})
it('does not trust a PDF filename, missing original, or a retained size mismatch', async () => {
  vi.stubGlobal('Blob', NodeBlob)
  const store = createMemoryStore()
  await expect(readPdfOriginal(version('missing'), store)).rejects.toThrow(/unavailable/)
  await store.putBlob({ meta: { id: 'not-pdf', kind: 'file', mime: 'application/pdf', bytes: 6, createdAt: 0, nodeId: null }, data: new Uint8Array([60, 104, 116, 109, 108, 62]) })
  await expect(readPdfOriginal(version('not-pdf'), store)).rejects.toThrow(/not a PDF/)
  expect(isPdfVersion(version('not-pdf'))).toBe(true)
  expect(isPdfVersion({ ...version('id'), originalName: 'note.txt' })).toBe(false)
})
it('anchors selection to a PDF page using zoom-independent clipped rectangles and exact selected wording', () => {
  document.body.innerHTML = '<div id="page"><div class="textLayer"><span>First copper </span><span>orchard and tail.</span></div></div>'
  const page = document.getElementById('page')!, layer = page.querySelector('.textLayer')!, range = document.createRange()
  range.setStart(layer.firstChild!.firstChild!, 6); range.setEnd(layer.lastChild!.firstChild!, 7)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 600, height: 800, right: 700, bottom: 850 } as DOMRect)
  Object.defineProperty(range, 'getClientRects', { value: () => [
    { left: 130, top: 90, right: 250, bottom: 110 },
    { left: 130, top: 90, right: 250, bottom: 110 },
    { left: 690, top: 120, right: 720, bottom: 140 }
  ] })
  expect(pdfSelection(page, 2, selection)).toEqual({ page: 2, quote: 'copper orchard', prefix: 'First ', suffix: ' and tail.', rects: [{ x: .05, y: .05, width: .2, height: .025 }, { x: .983333, y: .0875, width: .016667, height: .025 }] })
  selection.collapseToStart(); expect(pdfSelection(page, 2, selection)).toBeNull()
})
it('rejects selections crossing out of the PDF page text layer', () => {
  document.body.innerHTML = '<div id="page"><div class="textLayer">Inside</div></div><p>Outside</p>'
  const range = document.createRange(); range.setStart(document.querySelector('.textLayer')!.firstChild!, 0); range.setEnd(document.querySelector('p')!.firstChild!, 4)
  const selection = window.getSelection()!; selection.addRange(range)
  expect(pdfSelection(document.getElementById('page')!, 1, selection)).toBeNull()
})
