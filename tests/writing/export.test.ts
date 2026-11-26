// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { readWorldSnapshot, referencedWorldAssets, writingOriginalReferences, PORTABLE_WORLD_KEYS } from '../../src/data/worldSnapshot.ts'
import { defaultWritingAppearance, validateWritingDocument } from '../../src/writing/model.ts'
import type { WritingDocument } from '../../src/writing/types.ts'
import { uploadWritingMedia, writingMediaHash } from '../../src/writing/media.ts'
import { exportWritingDocument, MAX_WRITING_EXPORT_MEDIA_BYTES } from '../../src/writing/export.ts'
import { blobSink, exportArchive, importArchive, readArchive } from '../../src/data/archive.ts'
import { exportDirectoryBundle, readDirectoryBundle, restoreDirectoryBundle, type BundleReader, type BundleWriter } from '../../src/data/directoryBundle.ts'
import { emptyReading } from '../../src/reading/model.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,1])
function document(): WritingDocument { return { id: 'writing-test', title: 'A careful <script> title', subtitle: 'A subtitle & an idea', byline: 'A reader', format: 'essay', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'A retained heading' }] }, { type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror="unsafe()"> & exact words', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#123456', fontSize: '22px' } }] }] }] }, appearance: { ...defaultWritingAppearance(), background: 'waves', waveColor: '#abc', waveIntensity: 40 }, createdAt: 1, updatedAt: 2, archivedAt: null } }
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }) })
afterEach(async () => { await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function withMedia() { const media = (await uploadWritingMedia([new NodeFile([png], 'original.png', { type: 'image/png' }) as unknown as File]))[0], doc = document(); doc.content.content!.push({ type: 'writingMedia', attrs: { ...media, alt: 'A retained original', caption: 'Exact caption.' } }, { type: 'writingEmbed', attrs: { url: 'https://vimeo.com/123', provider: 'vimeo' } }); doc.appearance.background = 'image'; doc.appearance.backgroundAssetId = media.assetId; return { doc, media } }

it('exports escaped, self-contained HTML preserving appearance and local originals without scripts or automatic external embeds', async () => {
  const { doc } = await withMedia(), result = await exportWritingDocument(doc, 'html'), text = await result.blob.text(), parsed = new DOMParser().parseFromString(text, 'text/html')
  expect(result.name).toMatch(/\.html$/); expect(parsed.querySelector('script')).toBeNull(); expect(parsed.querySelector('[onerror]')).toBeNull()
  expect(parsed.querySelector('h1')?.textContent).toBe(doc.title)
  expect(parsed.querySelector('.document-content p')?.textContent).toBe('<img src=x onerror="unsafe()"> & exact words')
  expect(parsed.querySelector('.document-content img')?.getAttribute('src')).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`)
  expect(text).toContain('color:#123456;font-size:22px'); expect(text).toContain(`background-image:url('data:image/png;base64,`)
  expect(parsed.querySelector('iframe')).toBeNull(); expect(parsed.querySelector('.external-video a')?.getAttribute('href')).toBe('https://vimeo.com/123')
  expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("connect-src 'none'")
})

it('creates a media bundle with exact original bytes and a validated round-trip rich document', async () => {
  const { doc, media } = await withMedia(), result = await exportWritingDocument(doc, 'bundle'), entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
  const manifest = JSON.parse(strFromU8(entries['writing.json']))
  expect(validateWritingDocument(manifest.document)).toEqual(validateWritingDocument(doc))
  expect(manifest.assets).toMatchObject([{ assetId: media.assetId, bytes: png.byteLength, mime: 'image/png', sha256: await writingMediaHash(png) }])
  expect(entries[manifest.assets[0].path]).toEqual(png)
  expect(strFromU8(entries['document.md'])).toContain(`![A retained original](assets/${media.assetId}.png)`)
  expect(strFromU8(entries['document.html'])).toContain('data:image/png;base64,')
  const restored = createMemoryStore()
  for (const asset of manifest.assets) await restored.putBlob({ meta: { id: asset.assetId, kind: 'image', mime: asset.mime, bytes: asset.bytes, createdAt: 1, nodeId: null }, data: entries[asset.path] })
  await restored.putKv('writing.v1', { schemaVersion: 1, revision: 1, docs: [manifest.document] })
  expect(await restored.getBlob(media.assetId).then((blob) => blob!.arrayBuffer()).then((bytes) => new Uint8Array(bytes))).toEqual(png)
  restored.close()
})

it('exports semantic Markdown directly without assets and bundles readable asset references when needed', async () => {
  const doc = document(); doc.content.content!.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep exact evidence.' }] }] }] }, { type: 'codeBlock', attrs: { language: 'txt' }, content: [{ type: 'text', text: '``` is literal text' }] })
  const plain = await exportWritingDocument(doc, 'markdown'), text = await plain.blob.text()
  expect(plain.name).toMatch(/\.md$/); expect(text).toContain('## A retained heading'); expect(text).toContain('- Keep exact evidence\\.'); expect(text).toContain('````txt\n``` is literal text\n````')
  const media = await withMedia(), bundled = await exportWritingDocument(media.doc, 'markdown')
  expect(bundled.name).toMatch(/-markdown\.zip$/)
  expect(unzipSync(new Uint8Array(await bundled.blob.arrayBuffer()))['writing.json']).toBeTruthy()
})

it('fails completely for unsafe rich content, missing originals or an oversized media export', async () => {
  const unsafe = document(); unsafe.content.content![1].content![0].marks = [{ type: 'link', attrs: { href: 'javascript:unsafe()' } }]
  await expect(exportWritingDocument(unsafe, 'html')).rejects.toThrow(/unsupported format/)
  const { doc, media } = await withMedia()
  vi.spyOn(getStore(), 'getAssetMeta').mockResolvedValueOnce(undefined)
  await expect(exportWritingDocument(doc, 'bundle')).rejects.toThrow(/original is missing/)
  const meta = (await getStore().getAssetMeta(media.assetId))!
  vi.spyOn(getStore(), 'getAssetMeta').mockResolvedValue({ ...meta, bytes: MAX_WRITING_EXPORT_MEDIA_BYTES + 1 })
  const read = vi.spyOn(getStore(), 'getBlob')
  await expect(exportWritingDocument(doc, 'html')).rejects.toThrow(/64 MiB/); expect(read).not.toHaveBeenCalled()
})

it('refuses a late export after workspace replacement', async () => {
  const { doc, media } = await withMedia(), store = getStore(), original = await store.getBlob(media.assetId)
  let release: (value: Blob | undefined) => void = () => {}
  const read = vi.spyOn(store, 'getBlob').mockImplementation(() => new Promise((resolve) => { release = resolve }))
  const exporting = exportWritingDocument(doc, 'bundle'); await vi.waitFor(() => expect(read).toHaveBeenCalled())
  await wipeWorld({ confirm: true }); release(original)
  await expect(exporting).rejects.toThrow(/workspace changed/)
})

it('bounds repeated HTML embeddings before loading originals, even when the unique media budget fits', async () => {
  const { doc, media } = await withMedia(), node = doc.content.content!.find((entry) => entry.type === 'writingMedia')!
  doc.content.content = Array.from({ length: 6 }, () => structuredClone(node))
  const meta = (await getStore().getAssetMeta(media.assetId))!
  vi.spyOn(getStore(), 'getAssetMeta').mockResolvedValue({ ...meta, bytes: 32 * 1024 * 1024 })
  const read = vi.spyOn(getStore(), 'getBlob')
  await expect(exportWritingDocument(doc, 'html')).rejects.toThrow(/128 MiB/)
  expect(read).not.toHaveBeenCalled()
})

it('backs up media referenced only by archived drafts or older immutable publications', async () => {
  const { doc, media } = await withMedia(), old = `writing-${'a'.repeat(64)}`
  doc.archivedAt = 3
  await getStore().putKv('writing.v1', { schemaVersion: 1, revision: 1, docs: [doc] })
  const snapshot = await readWorldSnapshot(getStore())
  snapshot.kv['knowledge.v1'] = { versions: [{ originalBlobId: 'retained-rich-envelope', originalPurged: false, metadata: { format: 'writing', writingAssetIds: [old], content: { type: 'doc', content: [] }, appearance: {} } }, { originalBlobId: 'purged-rich-envelope', originalPurged: true, metadata: { writingAssetIds: [`writing-${'b'.repeat(64)}`] } }] }
  expect(PORTABLE_WORLD_KEYS).toContain('writing.v1')
  const referenced = referencedWorldAssets(snapshot)
  expect(referenced.has(media.assetId)).toBe(true); expect(referenced.has(old)).toBe(true); expect(referenced.has(`writing-${'b'.repeat(64)}`)).toBe(false)
  expect(() => writingOriginalReferences({ 'writing.v1': { schemaVersion: 1, docs: [{ content: { type: 'writingMedia', attrs: { assetId: 'https://bad.example/image' } } }] } })).toThrow(/invalid original/)
})

function directory(): BundleReader & BundleWriter {
  const files = new Map<string, Blob>()
  return { exists: async (path) => files.has(path), write: async (path, bytes) => { files.set(path, new Blob([bytes.slice()])) }, remove: async (path) => { files.delete(path) }, read: async (path) => { const result = files.get(path); if (!result) throw new Error(`Missing ${path}`); return result } }
}
async function historicalPublication() {
  const { doc, media } = await withMedia(), store = getStore(), original = new TextEncoder().encode(JSON.stringify({ format: 'worldview-writing.v1', document: doc })), originalId = `knowledge-${await writingMediaHash(original)}`
  await store.putBlob({ meta: { id: originalId, kind: 'file', mime: 'application/json', bytes: original.byteLength, nodeId: null, createdAt: 1 }, data: original })
  const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [{ id: 'published-writing', externalId: `writing:${doc.id}`, title: doc.title, kind: 'document', currentVersionId: 'retained-writing-version', createdAt: 1, updatedAt: 2, excluded: false, aiAllowed: true, tags: [] }], versions: [{ id: 'retained-writing-version', sourceId: 'published-writing', contentHash: await writingMediaHash(original), originalBlobId: originalId, originalName: 'writing.json', text: 'Retained writing source.', createdAt: 2, authoredAt: 2, origin: 'capture', metadata: { format: 'writing', writingAssetIds: [media.assetId], content: doc.content, appearance: doc.appearance } }], passages: [], imports: [], jobs: [], proposals: [] }
  await store.putKv('knowledge.v1', snapshot)
  // The editable draft no longer uses this image; only the immutable publication does.
  doc.content = { type: 'doc', content: [{ type: 'paragraph' }] }; doc.appearance.backgroundAssetId = null; doc.appearance.background = 'solid'
  await store.putKv('writing.v1', { schemaVersion: 1, revision: 2, docs: [doc] })
  return { store, media }
}

it.each(['archive', 'directory'] as const)('retains historical published originals in a %s backup and rejects altered bytes even with fresh container checksums', async (format) => {
  const { store, media } = await historicalPublication(), restored = createMemoryStore(), corrupted = png.slice(); corrupted[corrupted.length - 1] ^= 7
  const sink = blobSink(), files = directory()
  if (format === 'archive') { await exportArchive(store, sink); await importArchive(restored, sink.blob(), { allowWithoutBackup: true }) }
  else { await exportDirectoryBundle(store, files); await restoreDirectoryBundle(restored, files) }
  expect(new Uint8Array(await (await restored.getBlob(media.assetId))!.arrayBuffer())).toEqual(png)
  expect(await restored.getKv('writing.v1')).toMatchObject({ schemaVersion: 1, docs: [{ appearance: { backgroundAssetId: null } }] })
  const meta = (await store.getAssetMeta(media.assetId))!
  await store.putBlob({ meta, data: corrupted })
  if (format === 'archive') await expect(exportArchive(store, blobSink())).rejects.toThrow(/SHA-256/)
  else await expect(exportDirectoryBundle(store, directory())).rejects.toThrow(/SHA-256/)
  if (format === 'archive') {
    const entries = unzipSync(new Uint8Array(await sink.blob().arrayBuffer())); entries[`assets/${media.assetId}`] = corrupted
    await expect(readArchive(new Blob([zipSync(entries)]))).rejects.toThrow(/SHA-256/)
  } else {
    const manifest = JSON.parse(await (await files.read('manifest.json')).text()) as { entries: { path: string; parts: { path: string; sha256: string }[] }[] }
    const part = manifest.entries.find((entry) => entry.path === `assets/${media.assetId}`)!.parts[0]
    await files.write(part.path, corrupted); part.sha256 = await writingMediaHash(corrupted)
    await files.write('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(readDirectoryBundle(files)).rejects.toThrow(/SHA-256/)
  }
  restored.close()
})

it.each(['archive', 'directory'] as const)('refuses a %s backup when historical writing metadata refers to a missing original', async (format) => {
  const { store, media } = await historicalPublication(); await store.deleteBlob(media.assetId)
  if (format === 'archive') await expect(exportArchive(store, blobSink())).rejects.toThrow(/missing/)
  else await expect(exportDirectoryBundle(store, directory())).rejects.toThrow(/missing/)
})

it('exports structured tables, version-bound quotations, wiki links and real endnotes without losing provenance', async () => {
  const doc = document()
  doc.content.content!.push(
    { type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Question' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Evidence' }] }] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Why?' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A retained answer' }] }] }] },
    ] },
    { type: 'writingCitation', attrs: { sourceId: 'source-1', versionId: 'version-7', sourceTitle: 'A paper & its source', quote: 'A precise quotation.', start: 15, end: 35, url: 'https://example.com/source', page: 2 } },
    { type: 'paragraph', content: [{ type: 'writingTopicLink', attrs: { topicId: 'topic-1', label: 'Physics' } }, { type: 'text', text: ' A claim' }, { type: 'writingFootnote', attrs: { id: 'note-1', text: 'The full note, <escaped> & exact.' } }] },
  )
  const html = await (await exportWritingDocument(doc, 'html')).blob.text(), parsed = new DOMParser().parseFromString(html, 'text/html')
  expect(parsed.querySelectorAll('table tr')).toHaveLength(2)
  expect(parsed.querySelectorAll('table th')).toHaveLength(2)
  expect(parsed.querySelector('.writing-citation')?.getAttribute('data-source-version')).toBe('version-7')
  expect(parsed.querySelector('.writing-citation')?.textContent).toContain('page 2')
  expect(parsed.querySelector('.writing-citation a')?.getAttribute('href')).toBe('https://example.com/source')
  expect(parsed.querySelector('.writing-topic-link')?.getAttribute('data-topic-id')).toBe('topic-1')
  expect(parsed.querySelector('.writing-footnote-ref a')?.getAttribute('href')).toBe('#fn-note-1')
  expect(parsed.querySelector('#fn-note-1')?.textContent).toBe('The full note, <escaped> & exact.')
  const md = await (await exportWritingDocument(doc, 'markdown')).blob.text()
  expect(md).toContain('| Question | Evidence |')
  expect(md).toContain('version version\\-7')
  expect(md).toContain('[[Physics]]')
  expect(md).toContain('[^fn-note-1]')
  expect(md).toContain('[^fn-note-1]: The full note')
})

it('keeps merged table cells and partially measured column widths in HTML and Markdown exports', async () => {
  const doc = document()
  doc.content = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [0, 140] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two columns together' }] }] }] }] }] }
  const html = await (await exportWritingDocument(doc, 'html')).blob.text(), md = await (await exportWritingDocument(doc, 'markdown')).blob.text()
  expect(html).toContain('colspan="2"')
  expect(html).toContain('min-width:140px')
  expect(md).toContain('<table>')
  expect(md).toContain('colspan="2"')
})

it('exports marked reading concepts as Obsidian links while preserving examples and rich passage identities', async () => {
  const doc = document()
  const mark = (id: string, relation = 'concept') => ({ type: 'writingConcept', attrs: { id, topicId: 'concept-1', relation, createdAt: 1, updatedAt: 1 } })
  await getStore().putKv('reading.v1', { ...emptyReading(), topics: [{ id: 'concept-1', name: 'Virtù', createdAt: 1 }] })
  doc.content = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Virtù', marks: [mark('one')] },
    { type: 'text', text: ' or ' },
    { type: 'text', text: 'civic skill', marks: [mark('two')] },
    { type: 'text', text: '. A political example.', marks: [mark('three', 'example')] },
  ] }] }
  const exported = await exportWritingDocument(doc, 'bundle')
  const entries = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()))
  expect(strFromU8(entries['document.md'])).toContain('[[Virtù]] or [[Virtù|civic skill]]')
  expect(strFromU8(entries['document.md'])).toContain('Example of [[Virtù]]')
  expect(strFromU8(entries['document.html'])).toContain('data-topic-id="concept-1" data-relation="example"')
  expect(JSON.parse(strFromU8(entries['writing.json'])).document.content).toEqual(doc.content)
})

it('round-trips editable freehand geometry and exports its colors, points and description', async () => {
  const doc = document(), sketch = { type: 'writingSketch', attrs: {
    title: 'Side <view> & notes',
    strokes: [{ ink: '#365e8a', width: 4, points: [[30, 40], [100, 15], [135, 28]] }],
  } }
  doc.content.content!.push(sketch)
  const result = await exportWritingDocument(doc, 'bundle')
  const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
  const restored = validateWritingDocument(JSON.parse(strFromU8(entries['writing.json'])).document)
  expect(restored.content.content?.at(-1)).toEqual(sketch)
  for (const name of ['document.md', 'document.html']) {
    const parser = new DOMParser().parseFromString(strFromU8(entries[name]), 'text/html')
    expect(parser.querySelector('svg title')?.textContent).toBe('Side <view> & notes')
    expect(parser.querySelector('svg path')?.getAttribute('d')).toBe('M30 40 L100 15 L135 28')
    expect(parser.querySelector('svg path')?.getAttribute('stroke')).toBe('#365e8a')
  }
  const invalid = structuredClone(doc)
  invalid.content.content!.at(-1)!.attrs!.strokes = [{ ink: 'red', width: 4, points: [[-1, 0]] }]
  expect(() => validateWritingDocument(invalid)).toThrow()
})
