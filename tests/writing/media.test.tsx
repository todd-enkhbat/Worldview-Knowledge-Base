// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NodeViewProps } from '@tiptap/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { useWorld } from '../../src/app/store.ts'
import { MAX_ATTACHMENT_BYTES } from '../../src/data/attachments.ts'
import { parseWritingEmbed, readWritingMedia, uploadWritingBackground, uploadWritingMedia, writingMediaHash } from '../../src/writing/media.ts'
import { useWritingAssetUrl, WritingEmbedView, WritingMediaView } from '../../src/writing/WritingMediaView.tsx'

vi.mock('@tiptap/react', () => ({ NodeViewWrapper: ({ children, className, contentEditable }: { children: React.ReactNode; className: string; contentEditable: boolean }) => <div className={className} contentEditable={contentEditable}>{children}</div>, useEditorState: ({ editor, selector }: { editor: unknown; selector: (input: { editor: unknown }) => unknown }) => selector({ editor }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,1]), wav = new TextEncoder().encode('RIFF0000WAVEfmt ')
const file = (bytes = png, name = 'original.png', type = 'image/png') => new NodeFile([bytes], name, { type }) as unknown as File
let root: Root, host: HTMLDivElement
const createUrl = vi.fn(() => `blob:writing-${createUrl.mock.calls.length}`), revokeUrl = vi.fn()
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob); createUrl.mockClear(); revokeUrl.mockClear()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = createUrl; static override revokeObjectURL = revokeUrl })
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function until(check: () => boolean) { for (let count = 0; count < 100 && !check(); count++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }); expect(check()).toBe(true) }
function Preview({ id }: { id: string }) { const result = useWritingAssetUrl(id); return <div>{result.url && <img src={result.url} alt="Retained original" />}{result.error}</div> }

it('retains exact original bytes by content hash, sniffs renamed images and never creates spatial records', async () => {
  const uploaded = await uploadWritingMedia([file(png, '../picture.jpg', 'text/html'), file(png, 'same.png')])
  const id = `writing-${await writingMediaHash(png)}`
  expect(uploaded).toMatchObject([{ assetId: id, name: 'picture.jpg', mime: 'image/png', kind: 'image', width: 'normal' }, { assetId: id }])
  expect(new Uint8Array(await (await getStore().getBlob(id))!.arrayBuffer())).toEqual(png)
  expect(await getStore().listAssets()).toHaveLength(1); expect(useWorld.getState().nodes.size).toBe(0)
  expect(await uploadWritingBackground(file())).toBe(id)
})

it('rejects SVG, HTML MIME spoofing, oversized originals and audio backgrounds before publishing a mixed batch', async () => {
  const svg = file(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'), 'picture.svg', 'image/svg+xml')
  await expect(uploadWritingMedia([file(), svg])).rejects.toThrow(/SVG/)
  await expect(uploadWritingMedia([file(new TextEncoder().encode('<html><script>unsafe()</script></html>'), 'spoof.png', 'image/png')])).rejects.toThrow(/HTML/)
  const oversized = file(); Object.defineProperty(oversized, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
  await expect(uploadWritingMedia([oversized])).rejects.toThrow(/256 MiB/)
  await expect(uploadWritingBackground(file(wav, 'speech.wav', 'audio/wav'))).rejects.toThrow(/background image/)
  expect(await getStore().listAssets()).toEqual([])
})

it('refuses a late upload after a same-store workspace replacement', async () => {
  const original = file(); let release: (bytes: ArrayBuffer) => void = () => {}
  const fullRead = vi.spyOn(original, 'arrayBuffer').mockImplementation(() => new Promise((resolve) => { release = resolve }))
  const pending = uploadWritingMedia([original]); await vi.waitFor(() => expect(fullRead).toHaveBeenCalled())
  await wipeWorld({ confirm: true }); release(png.slice().buffer)
  await expect(pending).rejects.toThrow(/workspace changed/)
  expect(await getStore().listAssets()).toEqual([])
})

it('revokes local preview object URLs when changing originals and unmounting, with no remote fetch', async () => {
  const first = (await uploadWritingMedia([file()]))[0], second = (await uploadWritingMedia([file(new Uint8Array([...png, 2]), 'second.png')]))[0]
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<Preview id={first.assetId} />)); await until(() => !!host.querySelector('img'))
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:writing-1')
  await act(async () => root.render(<Preview id={second.assetId} />)); await until(() => host.querySelector('img')?.getAttribute('src') === 'blob:writing-2')
  expect(revokeUrl).toHaveBeenCalledWith('blob:writing-1')
  await act(async () => root.render(<Preview id="https://attacker.example/pixel.png" />)); await until(() => host.textContent!.includes('invalid local'))
  expect(host.querySelector('img')).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith('blob:writing-2'); expect(fetcher).not.toHaveBeenCalled()
})

it('rejects corrupted retained bytes before exposing an original URL', async () => {
  const item = (await uploadWritingMedia([file()]))[0], meta = (await getStore().getAssetMeta(item.assetId))!
  await getStore().putBlob({ meta, data: new Uint8Array([...png.slice(0, -1), 9]) })
  await expect(readWritingMedia(item.assetId)).rejects.toThrow(/content check/)
  expect(createUrl).not.toHaveBeenCalled()
})

it('renders external videos only after explicit consent and refuses deceptive or active URLs', async () => {
  const safe = parseWritingEmbed('https://youtu.be/dQw4w9WgXcQ?t=1')!
  expect(safe.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
  for (const value of ['javascript:alert(1)', 'http://youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ', 'https://user:pass@vimeo.com/123']) expect(parseWritingEmbed(value)).toBeNull()
  const props = { node: { attrs: { url: safe.url } }, selected: false, editor: { isEditable: true }, deleteNode: vi.fn() } as unknown as NodeViewProps
  await act(async () => root.render(<WritingEmbedView {...props} />))
  expect(host.querySelector('iframe')).toBeNull()
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load external video')!.click())
  expect(host.querySelector('iframe')?.getAttribute('src')).toBe(safe.embedUrl)
  expect(host.querySelector('iframe')?.getAttribute('src')).not.toContain('autoplay')
  await act(async () => root.render(<WritingEmbedView {...props} node={{ attrs: { url: 'https://vimeo.com/123' } } as unknown as NodeViewProps['node']} />))
  expect(host.querySelector('iframe')).toBeNull()
})

it('offers keyboard image resizing with bounded percentages and removes editable controls in preview', async () => {
  const attributes = (await uploadWritingMedia([file()]))[0], updateAttributes = vi.fn()
  const props = { node: { attrs: { ...attributes, displayWidth: 72 } }, selected: true, editor: { isEditable: true }, updateAttributes, deleteNode: vi.fn() } as unknown as NodeViewProps
  await act(async () => root.render(<WritingMediaView {...props} />))
  const handle = host.querySelector<HTMLButtonElement>('[aria-label="Resize image"]')!
  expect(handle).not.toBeNull()
  act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true })) })
  expect(updateAttributes).toHaveBeenLastCalledWith({ displayWidth: 77 })
  act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })) })
  expect(updateAttributes).toHaveBeenLastCalledWith({ displayWidth: 100 })
  act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })) })
  expect(updateAttributes).toHaveBeenLastCalledWith({ displayWidth: 20 })
  await act(async () => root.render(<WritingMediaView {...props} editor={{ isEditable: false } as NodeViewProps['editor']} />))
  expect(host.querySelector('[aria-label="Resize image"]')).toBeNull()
  expect(host.querySelector('[aria-label="Media block settings"]')).toBeNull()
})
