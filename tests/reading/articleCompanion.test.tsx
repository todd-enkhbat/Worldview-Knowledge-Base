// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { useWorld } from '../../src/app/store.ts'
import { resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import { captureArticle } from '../../src/reading/captureArticle.ts'
import { articleIdentity } from '../../src/reading/articleIdentity.ts'
import { resetReading, useReading } from '../../src/reading/store.ts'
import { extractArticle } from '../../extensions/worldview-reader/extract.js'
import { BrowserCaptureSetup } from '../../src/reading/BrowserCaptureSetup.tsx'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(input?: string) { return new Uint8Array(super.encode(input)) } })
  resetKnowledge(); resetReading()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
})
afterEach(async () => { document.body.replaceChildren(); await closeRepo(); resetKnowledge(); resetReading(); vi.unstubAllGlobals() })

it('captures a pasted article with retained provenance, a separate personal note, and no spatial node', async () => {
  const input = { title: 'Synthetic article', url: 'https://example.com/article?utm_source=test#quote', text: 'Exact third-party article wording.', remark: 'My own response to this article.' }
  const first = await captureArticle(input), snapshot = useKnowledge.getState()
  expect(snapshot.sources).toHaveLength(1); expect(snapshot.sources[0].nodeId).toBeUndefined(); expect(useWorld.getState().nodes.size).toBe(0)
  expect(snapshot.passages[0]).toMatchObject({ role: 'third-party', text: input.text, authoredAt: null })
  const version = snapshot.versions[0]
  expect(version.metadata).toMatchObject({ url: input.url, canonicalUrl: 'https://example.com/article', format: 'article', captureMethod: 'paste' })
  expect(JSON.parse(await (await getStore().getBlob(version.originalBlobId))!.text())).toMatchObject({ text: input.text, url: input.url })
  expect(useReading.getState().items[0].sourceId).toBe(first.sourceId)
  expect(useReading.getState().notes[0].text).toBe(input.remark)
  const repeated = await captureArticle({ ...input, remark: undefined, url: 'https://example.com/article?utm_medium=other' })
  expect(repeated.sourceId).toBe(first.sourceId); expect(useKnowledge.getState().versions).toHaveLength(1)
})

it('keeps meaningful query/hash routes while dropping ordinary anchors and tracking parameters', () => {
  expect(articleIdentity('https://example.com/article?id=4&utm_source=x#paragraph').canonicalUrl).toBe('https://example.com/article?id=4')
  expect(articleIdentity('https://example.com/#/articles/4').canonicalUrl).toBe('https://example.com/#/articles/4')
  expect(() => articleIdentity('file:///private/file')).toThrow(/http/)
  expect(() => articleIdentity('https://user:secret@example.com/article')).toThrow(/credentials/)
})

it('never reads or creates a SQLite browser pairing while the active library uses browser storage', async () => {
  getStore().info.kind = 'idb'
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    await act(async () => root.render(<BrowserCaptureSetup />))
    expect(host.textContent).toContain('Move to SQLite')
    expect(fetcher).not.toHaveBeenCalled()
    const pairingButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Create 90-day pairing')!
    expect(pairingButton.disabled).toBe(true)
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fetcher).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Open the local SQLite workspace')
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('extracts only the chosen article and anchors an explicit cross-node selection to its exact retained text', () => {
  document.body.innerHTML = '<nav>Unrelated navigation</nav><article><h1>Article title</h1><p>The copper <em>orchard</em> uses local storage.</p><p hidden>Hidden private text</p><form><label>Private input<input value="never capture this"></label></form><script>neverExecute()</script><p>The retained evidence remains readable.</p></article><footer>Unrelated footer</footer>'
  const paragraph = document.querySelector('article p')!, range = document.createRange()
  range.setStart(paragraph.firstChild!, 4); range.setEnd(paragraph.querySelector('em')!.firstChild!, 7)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const result = extractArticle(document)
  expect(result.text).toContain('The copper orchard uses local storage.')
  for (const omitted of ['Unrelated navigation', 'Hidden private', 'Private input', 'never capture', 'neverExecute', 'Unrelated footer']) expect(result.text).not.toContain(omitted)
  expect(result.selection?.quote).toBe('copper orchard')
  expect(result.text.slice(result.selection!.start, result.selection!.end)).toBe(result.selection!.quote)
})
