// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeRepo, completeFirstRun, getStore, getWorldGeneration, handleRemoteChange, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { initializeKnowledge, resetKnowledge } from '../../src/knowledge/index.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { createWritingDocument, initializeWriting, plainTextFromWriting, publishWritingDocument, resetWriting, useWriting, writingFromPlainText, WRITING_KV, type WritingDocument, type WritingSnapshot } from '../../src/writing/store.ts'
import { useWritingDraft } from '../../src/writing/useWritingDraft.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, store: ReturnType<typeof createMemoryStore>, doc: WritingDocument
function Session({ document }: { document: WritingDocument }) {
  const { draft, update, flush, status, error, reload } = useWritingDraft(document)
  return <div><label>Writing<textarea aria-label="Writing" value={plainTextFromWriting(draft.content)} onChange={(event) => update({ content: writingFromPlainText(event.target.value) })} /></label><output aria-label="Save status">{status}</output>{error && <><p role="alert">{error}</p><button onClick={() => reload(document)}>Reload saved version</button></>}<button onClick={() => { void flush().catch(() => {}) }}>Save now</button><button onClick={() => { void flush().then(() => publishWritingDocument(draft.id)).catch(() => {}) }}>{draft.sourceId ? 'Save revision' : 'Save to Library'}</button></div>
}
function Harness({ id, visible }: { id: string; visible: boolean }) {
  const document = useWriting((state) => state.docs.find((entry) => entry.id === id))
  return <Activity mode={visible ? 'visible' : 'hidden'}>{document && <Session key={`${getWorldGeneration()}:${document.id}`} document={document} />}</Activity>
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(input?: string) { return new Uint8Array(super.encode(input)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Autosave must remain local') }))
  resetWriting(); resetKnowledge(); store = createMemoryStore()
  await initRepo({ store }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge(); await initializeWriting()
  doc = await createWritingDocument({ title: 'Autosave study', content: writingFromPlainText('Initially saved words.') })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await closeRepo(); resetWriting(); resetKnowledge(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(visible = true) { await act(async () => root.render(<Harness id={doc.id} visible={visible} />)) }
const text = () => host.querySelector<HTMLTextAreaElement>('textarea')!
const status = () => host.querySelector('output')?.textContent
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!
async function type(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text(), value); text().dispatchEvent(new Event('input', { bubbles: true })) }) }
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  expect(check(), host.textContent ?? 'Writing UI unavailable').toBe(true)
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
const savedText = async (target = store) => plainTextFromWriting((await target.getKv<WritingSnapshot>(WRITING_KV))!.docs[0].content)

it('never erases newer typed text when an earlier CAS response completes, and saves the newer edit next', async () => {
  await render()
  const started = deferred(), gate = deferred(), swap = store.compareAndSwapKv.bind(store)
  let first = true
  store.compareAndSwapKv = async (key, value, revision) => { if (key === WRITING_KV && first) { first = false; started.resolve(); await gate.promise } return swap(key, value, revision) }
  await type('First submitted draft.')
  await act(async () => button('Save now').click()); await started.promise
  await type('Newer words typed while the first save is pending.\nKeep both lines.')
  await act(async () => { gate.resolve(); await gate.promise })
  await until(() => status() === 'dirty')
  expect(text().value).toBe('Newer words typed while the first save is pending.\nKeep both lines.')
  await act(async () => button('Save now').click()); await until(() => status() === 'saved')
  expect(await savedText()).toBe(text().value)
})

it('finishes a hidden Activity save and shows saved status with no stale unload warning on reveal', async () => {
  await render()
  const started = deferred(), gate = deferred(), swap = store.compareAndSwapKv.bind(store)
  let first = true
  store.compareAndSwapKv = async (key, value, revision) => { if (key === WRITING_KV && first) { first = false; started.resolve(); await gate.promise } return swap(key, value, revision) }
  await type('Words saved while the writing desk is hidden.')
  await act(async () => button('Save now').click()); await started.promise
  await render(false)
  await act(async () => { gate.resolve(); await gate.promise })
  await until(() => plainTextFromWriting(useWriting.getState().docs[0].content) === 'Words saved while the writing desk is hidden.')
  await render(true); await until(() => status() === 'saved')
  expect(text().value).toBe('Words saved while the writing desk is hidden.')
  const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving)
  expect(leaving.defaultPrevented).toBe(false)
})

it('merges same-edit-revision publication metadata into the UI while keeping a newer unsaved local draft', async () => {
  await render(); await type('Still typing newer words during publication.')
  const before = useWriting.getState().docs[0].updatedAt
  let published!: { sourceId: string; versionId: string }
  await act(async () => { published = await publishWritingDocument(doc.id) })
  expect(useWriting.getState().docs[0].updatedAt).toBe(before)
  expect(button('Save revision')).toBeTruthy()
  expect(text().value).toBe('Still typing newer words during publication.')
  expect(status()).toBe('dirty')
  const corpus = await getStore().getKv<KnowledgeSnapshot>('knowledge.v1')
  expect(corpus!.versions.find((version) => version.id === published.versionId)?.text).toBe('Initially saved words.')
  await act(async () => button('Save now').click()); await until(() => status() === 'saved')
  expect(await savedText()).toBe('Still typing newer words during publication.')
  expect(button('Save revision')).toBeTruthy()
})

it('keeps local input and an actionable error when a remote revision conflicts, without overwriting its winning data', async () => {
  await render(); await type('My unsaved local interpretation.')
  const snapshot = (await store.getKv<WritingSnapshot>(WRITING_KV))!
  const incoming: WritingSnapshot = { ...snapshot, revision: snapshot.revision + 1, docs: [{ ...snapshot.docs[0], content: writingFromPlainText('The other writer’s winning revision.'), updatedAt: snapshot.docs[0].updatedAt + 10 }] }
  await act(async () => { await store.putKv(WRITING_KV, incoming); await handleRemoteChange({ type: 'kv', keys: [WRITING_KV] }) })
  await until(() => status() === 'error')
  expect(text().value).toBe('My unsaved local interpretation.')
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Your edits are still here')
  await render(false); await render(true)
  await until(() => status() === 'error')
  expect(text().value).toBe('My unsaved local interpretation.')
  expect(host.querySelector('[role=alert]')?.textContent?.trim()).toBeTruthy()
  expect(button('Reload saved version')).toBeTruthy()
  await act(async () => button('Save now').click()); await until(() => status() === 'error')
  expect(await store.getKv(WRITING_KV)).toEqual(incoming)
  expect(text().value).toBe('My unsaved local interpretation.')
  await act(async () => button('Reload saved version').click())
  expect(text().value).toBe('The other writer’s winning revision.')
  expect(status()).toBe('saved')
  expect(host.querySelector('[role=alert]')).toBeNull()
})

it('never leaks an old pending autosave into a new account that reuses the same document ID', async () => {
  await render(); await type('An old account’s unsaved private draft.')
  const read = store.getKv.bind(store), started = deferred(), gate = deferred(), original = await store.getKv(WRITING_KV), settings = await store.getSettings()
  store.getKv = async <T,>(key: string) => { if (key === WRITING_KV) { started.resolve(); await gate.promise } return read<T>(key) }
  await act(async () => button('Save now').click()); await started.promise
  const replacement = createMemoryStore(); await replacement.putSettings(settings!); await replacement.putKv(WRITING_KV, original)
  await act(async () => { await closeRepo(); await initRepo({ store: replacement }); await initializeWriting() })
  await render()
  expect(text().value).toBe('Initially saved words.')
  await type('Only the new account’s words.')
  await act(async () => button('Save now').click()); await until(() => status() === 'saved')
  await act(async () => { gate.resolve(); await gate.promise })
  expect(await savedText(replacement)).toBe('Only the new account’s words.')
  expect((await read<WritingSnapshot>(WRITING_KV))!.docs[0].content).toEqual(doc.content)
  expect(text().value).toBe('Only the new account’s words.')
})

it('flushes a draft on Activity hide before its debounce fires and retains it after a cold reopen', async () => {
  await render(); await type('A draft preserved when navigating away immediately.')
  await render(false)
  await until(() => plainTextFromWriting(useWriting.getState().docs[0].content) === 'A draft preserved when navigating away immediately.')
  await act(async () => root.render(null))
  resetWriting(); await initializeWriting()
  await render(true)
  expect(text().value).toBe('A draft preserved when navigating away immediately.')
  expect(status()).toBe('saved')
  expect(fetch).not.toHaveBeenCalled()
})
