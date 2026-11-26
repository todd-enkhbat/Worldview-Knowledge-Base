// @vitest-environment jsdom
import { Activity, StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { linkSavedQuote } from '../../src/writing/quoteLink.ts'
import { writingAuthorshipMessages } from '../../src/writing/authorship.ts'
import { writingPassages } from '../../src/writing/concepts.ts'
import { selectWritingPassage } from '../../src/writing/passageNavigation.ts'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichEditor, { type RichEditorProps } from '../../src/writing/RichEditor.tsx'
import { normalizedWritingJSON, sanitizeWritingPasteHTML } from '../../src/writing/extensions.ts'
import { validateWritingContent } from '../../src/writing/model.ts'
import type { WritingNode } from '../../src/writing/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, editor: Editor
let changed = vi.fn((_content: WritingNode) => {})
const doc = (text: string): WritingNode => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const initial = () => doc('Alpha beta gamma')
const byLabel = <T extends HTMLElement = HTMLButtonElement>(label: string) => {
  const element = host.querySelector<T>(`[aria-label="${label}"]`)
  if (!element) throw new Error(`Missing control: ${label}`)
  return element
}
function click(label: string) {
  const button = byLabel<HTMLButtonElement>(label)
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  act(() => { button.dispatchEvent(event); button.click() })
  return event
}
function select(label: string, value: string) {
  const control = byLabel<HTMLSelectElement>(label)
  act(() => { control.dispatchEvent(new Event('focusin', { bubbles: true })); control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(check(), host.textContent ?? '').toBe(true)
}
async function render(props: Partial<RichEditorProps> = {}) {
  await act(async () => root.render(<RichEditor documentId="doc-a" content={initial()} onChange={changed} onReady={(value) => { editor = value }} {...props} />))
  await until(() => !!editor && !editor.isDestroyed && host.contains(editor.view.dom))
}
function range(from = 1, to = 6) { act(() => { editor.commands.setTextSelection({ from, to }) }) }

beforeEach(() => {
  changed = vi.fn((_content: WritingNode) => {})
  editor = undefined as unknown as Editor
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The editor must not call a cloud API') }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  // ProseMirror's DOM selection code uses browser geometry unavailable in jsdom.
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 0, 0) })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await new Promise((resolve) => setTimeout(resolve, 5)); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('rich writing editor', () => {
  it('enables an empty document toolbar before typing or changing its selection', async () => {
    await render({ content: { type: 'doc', content: [{ type: 'paragraph' }] }, onUpload: async () => {} })
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('true')
    expect(byLabel<HTMLButtonElement>('Bold').disabled).toBe(false)
    expect(byLabel<HTMLSelectElement>('Text style').disabled).toBe(false)
    expect(byLabel<HTMLButtonElement>('Insert image').disabled).toBe(false)
    expect(byLabel<HTMLButtonElement>('Insert video file').disabled).toBe(false)
    expect(byLabel<HTMLButtonElement>('Insert audio file').disabled).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    click('Bold')
    expect(editor.isActive('bold')).toBe(true)
    expect(byLabel('Bold').getAttribute('aria-pressed')).toBe('true')
  })

  it('formats the selected text with real transactions and preserves the range through toolbar interactions', async () => {
    await render()
    range()
    expect(click('Bold').defaultPrevented).toBe(true)
    click('Italic'); click('Underline'); click('Strikethrough')
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(6)
    expect(editor.getHTML()).toContain('<strong>')
    expect(editor.getHTML()).toContain('<em>')
    expect(editor.getHTML()).toContain('<u>')
    expect(editor.getHTML()).toContain('<s>')
    select('Font family', 'Georgia, serif')
    select('Font size', '24px')
    select('Highlight color', '#fff2a8')
    expect(editor.getAttributes('textStyle')).toMatchObject({ fontFamily: 'Georgia, serif', fontSize: '24px' })
    expect(editor.getAttributes('highlight').color).toBe('#fff2a8')
    expect(editor.state.selection.to).toBe(6)
    expect(() => validateWritingContent(changed.mock.lastCall![0])).not.toThrow()
    expect(byLabel('Bold').getAttribute('aria-pressed')).toBe('true')
    click('Undo')
    expect(editor.isActive('highlight')).toBe(false)
    click('Redo')
    expect(editor.isActive('highlight')).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('supports keyboard marks, block styles, alignment, lists, links and dividers', async () => {
    await render()
    range()
    act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', keyCode: 66, ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(editor.isActive('bold')).toBe(true)
    act(() => { editor.commands.keyboardShortcut('Mod-u') })
    expect(editor.isActive('underline')).toBe(true)
    select('Text style', 'h2')
    click('Align center')
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2, textAlign: 'center' } })
    select('Text style', 'quote')
    expect(editor.isActive('blockquote')).toBe(true)
    select('Text style', 'paragraph')
    expect(editor.isActive('blockquote')).toBe(false)
    click('Bullet list')
    expect(editor.isActive('bulletList')).toBe(true)
    click('Numbered list')
    expect(editor.isActive('orderedList')).toBe(true)
    click('Numbered list')
    range(7, 11)
    click('Edit link')
    const url = host.querySelector<HTMLInputElement>('.writing-editor-link-form input')!
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, 'https://example.com/evidence'); url.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => host.querySelector<HTMLFormElement>('.writing-editor-link-form')!.requestSubmit())
    expect(editor.getHTML()).toContain('href="https://example.com/evidence"')
    expect(editor.state.selection.from).toBe(7)
    expect(editor.state.selection.to).toBe(11)
    click('Unlink')
    expect(editor.getHTML()).not.toContain('<a ')
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
    click('Insert divider')
    expect(editor.getJSON().content?.some((node) => node.type === 'horizontalRule')).toBe(true)
    expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON())), JSON.stringify(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
  })

  it('keeps the editor and selection on autosave echoes, and isolates a new document history', async () => {
    await render()
    const original = editor, body = editor.view.dom
    range()
    click('Bold')
    const echo = structuredClone(changed.mock.lastCall![0]) as WritingNode
    await render({ content: echo })
    expect(editor).toBe(original)
    expect(editor.view.dom).toBe(body)
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(6)
    expect(host.textContent).not.toContain('Another version')
    await render({ documentId: 'doc-b', content: doc('A different document') })
    expect(editor).not.toBe(original)
    expect(editor.getText()).toBe('A different document')
    expect(editor.can().undo()).toBe(false)
    await until(() => original.isDestroyed)
  })

  it('preserves local edits when different content arrives and offers an explicit version choice', async () => {
    await render()
    act(() => { editor.commands.insertContent('Local ') })
    const localText = editor.getText()
    await render({ content: doc('Incoming remote revision') })
    expect(editor.getText()).toBe(localText)
    expect(host.textContent).toContain('Your current edits are still here')
    const keep = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Keep my version')!
    act(() => keep.click())
    expect(editor.getText()).toBe(localText)
    expect(host.textContent).not.toContain('Another version')
    await render({ content: doc('Another incoming revision') })
    const load = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load incoming version')!
    act(() => load.click())
    expect(editor.getText()).toBe('Another incoming revision')
    expect(host.textContent).not.toContain('Another version of this document arrived')
  })

  it('makes read-only and preview views nonmutating while retaining page header and footer', async () => {
    await render({ editable: false, header: <h1>Document title</h1>, footer: <p>End of essay</p> })
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('false')
    expect(byLabel<HTMLButtonElement>('Bold').disabled).toBe(true)
    act(() => { editor.commands.insertContent('Blocked ') })
    expect(editor.getText()).toBe('Alpha beta gamma')
    expect(changed).not.toHaveBeenCalled()
    await render({ preview: true, header: <h1>Document title</h1>, footer: <p>End of essay</p> })
    expect(host.querySelector('.writing-rich-toolbar')).toBeNull()
    expect(host.querySelector('.writing-editor-page h1')?.textContent).toBe('Document title')
    expect(host.querySelector('.writing-editor-page')?.textContent).toContain('End of essay')
    expect(editor.isEditable).toBe(false)
    await render({ preview: false })
    expect(editor.isEditable).toBe(true)
    expect(byLabel<HTMLButtonElement>('Bold').disabled).toBe(false)
  })

  it('preserves supported pasted HTML and removes remote resources and unsafe links before schema insertion', async () => {
    await render()
    const html = '<p style="text-align:center"><strong>Formatted</strong> <span style="font-size:12pt;color:#123456">paste</span><img src="https://tracker.invalid/pixel" onerror="alert(1)"><iframe src="https://tracker.invalid/frame"></iframe><a href="javascript:alert(1)">unsafe</a><svg><image href="https://tracker.invalid/svg"/></svg></p>'
    const clean = sanitizeWritingPasteHTML(html)
    expect(clean).not.toMatch(/tracker|javascript|onerror|iframe|<img|<svg/i)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [], types: ['text/html', 'text/plain'], getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? 'Formatted paste unsafe' : '' } })
    act(() => { editor.view.dom.dispatchEvent(event) })
    expect(editor.getHTML()).toContain('<strong>Formatted</strong>')
    expect(editor.getHTML()).not.toMatch(/tracker|javascript|<iframe|<img|onerror/i)
    expect(editor.getHTML()).toContain('font-size: 16px')
    expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON())), JSON.stringify(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
    expect(host.querySelector('img,iframe')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains media/embed JSON and delegates pasted files without loading external embeds', async () => {
    const attrs = { assetId: `writing-${'a'.repeat(64)}`, kind: 'image', name: 'Local photo', mime: 'image/png', alt: 'An image description', caption: 'A retained local image', width: 'wide' }
    const upload = vi.fn(async (_files: File[], current: Editor) => { current.commands.insertContent({ type: 'writingMedia', attrs }) })
    await render({ onUpload: upload })
    const file = new File(['fixture'], 'photo.png', { type: 'image/png' })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [file], getData: () => '' } })
    await act(async () => { editor.view.dom.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(upload).toHaveBeenCalledWith([file], editor)
    act(() => { editor.commands.insertContent({ type: 'writingEmbed', attrs: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' } }) })
    const json = normalizedWritingJSON(editor.getJSON())
    expect(json.content?.find((node) => node.type === 'writingMedia')?.attrs).toEqual(attrs)
    expect(json.content?.some((node) => node.type === 'writingEmbed')).toBe(true)
    expect(() => validateWritingContent(json)).not.toThrow()
    expect(host.querySelector('iframe')).toBeNull()
    await render({ documentId: 'media-copy', content: json })
    expect(normalizedWritingJSON(editor.getJSON())).toEqual(json)
    expect(host.querySelector('iframe')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('survives StrictMode and an Activity hide/reveal without resetting an unacknowledged local draft', async () => {
    const ready = (value: Editor) => { editor = value }
    const renderActivity = async (visible: boolean) => {
      await act(async () => root.render(<StrictMode><Activity mode={visible ? 'visible' : 'hidden'}><RichEditor documentId="activity-doc" content={initial()} onChange={changed} onReady={ready} /></Activity></StrictMode>))
    }
    await renderActivity(true)
    await until(() => !!editor && !editor.isDestroyed)
    range(1, 6); click('Bold')
    const content = normalizedWritingJSON(editor.getJSON())
    await renderActivity(false)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    await renderActivity(true)
    await until(() => !!editor && !editor.isDestroyed && host.contains(editor.view.dom))
    expect(normalizedWritingJSON(editor.getJSON())).toEqual(content)
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(6)
    expect(editor.isActive('bold')).toBe(true)
  })
})

describe('connected writing tools', () => {
  it('offers keyboard slash commands and keeps inserted tables valid and editable', async () => {
    await render()
    act(() => { editor.commands.setContent(doc('/tab')) })
    expect(host.querySelector('[role="listbox"][aria-label="Insert a block"]')).not.toBeNull()
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Table')
    act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(editor.getJSON().content?.some((node) => node.type === 'table')).toBe(true)
    expect(editor.getText()).not.toContain('/tab')
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
    act(() => { editor.commands.addRowAfter(); editor.commands.addColumnAfter() })
    expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets Escape dismiss a slash menu without destroying the typed text', async () => {
    await render()
    act(() => { editor.commands.setContent(doc('/heading')) })
    expect(host.querySelector('[role="listbox"]')).not.toBeNull()
    act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(editor.getText()).toBe('/heading')
  })

  it('formats through the floating toolbar and inserts an accessible footnote', async () => {
    await render()
    range(1, 6)
    expect(host.querySelector('[role="toolbar"][aria-label="Selection formatting"]')).not.toBeNull()
    click('Selection Bold')
    expect(editor.getHTML()).toContain('<strong>Alpha</strong>')
    range(6, 6)
    click('Insert footnote')
    const input = host.querySelector<HTMLTextAreaElement>('.writing-editor-link-form textarea')!
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'An exact source and an aside.'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => host.querySelector<HTMLFormElement>('.writing-editor-link-form')!.requestSubmit())
    expect(editor.getHTML()).toContain('Footnote: An exact source and an aside.')
    expect(editor.getJSON().content?.[0].content?.some((node) => node.type === 'writingFootnote')).toBe(true)
    expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
  })

  it('reorders complete heading sections with keyboard buttons and can undo the move', async () => {
    await render({ content: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'First section' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'First body' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Second section' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second body' }] },
    ] } })
    const before = normalizedWritingJSON(editor.getJSON())
    click('Reorder sections'); click('Move First section down')
    expect(normalizedWritingJSON(editor.getJSON()).content?.[0].content?.[0].text).toBe('Second section')
    expect(normalizedWritingJSON(editor.getJSON()).content?.[3].content?.[0].text).toBe('First body')
    act(() => { editor.commands.undo() })
    expect(normalizedWritingJSON(editor.getJSON())).toEqual(before)
  })

  it('converts a completed known wiki topic to a canonical inline link without inventing unknown topics', async () => {
    await render({ topics: [{ id: 'topic-physics', label: 'Physics' }], content: doc('[[physics]') })
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.view.someProp('handleTextInput', (handler) => handler(editor.view, editor.state.selection.from, editor.state.selection.to, ']', () => editor.state.tr.insertText(']'))) })
    expect(editor.getJSON().content?.[0].content?.[0]).toMatchObject({ type: 'writingTopicLink', attrs: { topicId: 'topic-physics', label: 'Physics' } })
    expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
    act(() => { expect(selectWritingPassage(editor, new URLSearchParams('atom=1&topic=topic-physics'))).toBe('selected') })
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 })
    expect(selectWritingPassage(editor, new URLSearchParams('atom=1&topic=other'))).toBe('changed')
    expect(selectWritingPassage(editor, new URLSearchParams('atom=999&topic=topic-physics'))).toBe('changed')
  })

  it('retains version-bound citations and rejects malformed provenance or unsafe source links', async () => {
    const citation: WritingNode = { type: 'writingCitation', attrs: { sourceId: 'source-a', versionId: 'version-a', sourceTitle: 'Original source', quote: 'Exact words', start: 10, end: 21, url: 'https://example.com/article', page: 3 } }
    const linked: WritingNode = { type: 'doc', content: [citation, { type: 'paragraph', content: [{ type: 'writingTopicLink', attrs: { topicId: 'topic-a', label: 'A topic' } }] }] }
    await render({ content: linked })
    expect(editor.getHTML()).toContain('data-source-version="version-a"')
    expect(editor.getHTML()).toContain('page 3')
    expect(normalizedWritingJSON(editor.getJSON())).toEqual(linked)
    expect(() => validateWritingContent({ type: 'doc', content: [{ ...citation, attrs: { ...citation.attrs, end: 22 } }] })).toThrow()
    expect(() => validateWritingContent({ type: 'doc', content: [{ ...citation, attrs: { ...citation.attrs, url: 'javascript:unsafe()' } }] })).toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('concepts in the writing editor', () => {
  it('fits the measured selection toolbar within a dialog with its own positioning origin', async () => {
    const modal = document.createElement('dialog')
    document.body.append(modal); modal.open = true; modal.append(host)
    const style = document.createElement('style')
    style.textContent = '.writing-selection-menu { position: fixed; }'
    modal.append(style)
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === modal) return new DOMRect(32, 18, 390, 600)
      if (this.classList.contains('writing-selection-menu')) return new DOMRect(
        32 + Number.parseFloat(this.style.left || '0'), 18 + Number.parseFloat(this.style.top || '0'), 304, 44,
      )
      return originalRect.call(this)
    })
    try {
      await render({ variant: 'notebook', conceptActions: { terms: [], resolve: vi.fn(), onQuote: vi.fn() } })
      vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 410, right: 410, top: 128, bottom: 150 })
      range(1, 6)
      const rect = byLabel('Selection formatting').getBoundingClientRect()
      expect(rect.right).toBe(414)
      expect(rect.bottom).toBe(122)
    } finally { document.body.append(host); modal.remove() }
  })

  it('links selected wording, recognizes aliases across formatting, opens either link, and timestamps edits', async () => {
    const terms = [{ id: 'virtue', label: 'Virtù', aliases: ['virtue'] }]
    const resolve = vi.fn(async () => ({ id: 'virtue', name: 'Virtù' }))
    const onQuote = vi.fn()
    const content: WritingNode = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Virtù and vir' }, { type: 'text', marks: [{ type: 'bold' }], text: 'tue' }, { type: 'text', text: ' develop.' },
    ] }] }
    await render({ content, topics: terms, conceptActions: { terms, resolve, onQuote } })
    expect(editor.view.dom.querySelectorAll('.writing-concept-mention').length).toBeGreaterThanOrEqual(2)
    expect(writingPassages(editor.getJSON())).toEqual([])
    range(1, 6)
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.writing-selection-menu button')].find(entry => entry.textContent === label)!
    await until(() => !!button('Make concept'))
    await act(async () => button('Make concept').click())
    expect(button('Open concept')).toBeTruthy()
    const [link] = writingPassages(editor.getJSON())
    expect(resolve).toHaveBeenCalledWith('Virtù')
    expect(link).toMatchObject({ text: 'Virtù', topicId: 'virtue', relation: 'concept', from: 1, to: 6 })
    expect(() => validateWritingContent(editor.getJSON())).not.toThrow()
    act(() => button('Quote').click())
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ text: 'Virtù', from: 1, to: 6 }))
    // Keep editing the prose while the link identity and original timestamp survive.
    act(() => editor.view.dispatch(editor.state.tr.insertText('x', 3)))
    const [edited] = writingPassages(editor.getJSON())
    expect(edited).toMatchObject({ id: link.id, text: 'Vixrtù', createdAt: link.createdAt })
    expect(edited.updatedAt).toBeGreaterThan(link.updatedAt)
    const explicit = editor.view.dom.querySelector<HTMLElement>('[data-passage-id]')!
    const recognized = editor.view.dom.querySelector<HTMLElement>('.writing-concept-mention')!
    for (const item of [explicit, recognized]) {
      location.hash = '#/write'
      act(() => item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })))
      expect(location.hash).toBe('#/topics?topic=virtue')
      location.hash = '#/write'
      act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
      expect(location.hash).toBe('#/topics?topic=virtue')
    }
  })

  it('lets a keyboard reader make a concept in place, reopen the saved note, and follow the link', async () => {
    const actions = { terms: [], resolve: vi.fn(async () => ({ id: 'virtù', name: 'Virtù' })), onQuote: vi.fn() }
    await render({ variant: 'notebook', content: doc('Virtù and fortune.'), conceptActions: actions })
    expect(byLabel('Reading note')).toBe(editor.view.dom)
    expect(byLabel('Note formatting').textContent).toContain('Select words to make a concept.')
    expect(host.querySelector('.writing-rich-toolbar')).toBeNull()
    range(1, 6)
    await act(async () => editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })))
    expect(actions.resolve).toHaveBeenCalledWith('Virtù')
    const saved = changed.mock.lastCall![0]
    await render({ variant: 'notebook', documentId: 'reopened', content: saved, conceptActions: actions })
    const link = editor.view.dom.querySelector<HTMLElement>('[data-writing-concept]')!
    expect(link.textContent).toBe('Virtù')
    location.hash = '#/bookshelf'
    act(() => link.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true, cancelable: true })))
    expect(location.hash).toBe('#/bookshelf')
    act(() => link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(location.hash).toBe('#/topics?topic=virt%C3%B9')
  })

  it('saves the exact selected sentence as an example of a named entity', async () => {
    const resolve = vi.fn(async () => ({ id: 'p', name: 'Palantir' }))
    await render({ conceptActions: { terms: [], resolve, onQuote: vi.fn() } })
    range(1, 11)
    const opener = () => [...host.querySelectorAll<HTMLButtonElement>('.writing-selection-menu button')].find(el => el.textContent === 'Example of…')
    await until(() => !!opener())
    act(() => opener()!.click())
    const form = host.querySelector<HTMLFormElement>('.writing-concept-form')!, input = form.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Palantir')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(resolve).toHaveBeenCalledWith('Palantir')
    expect(writingPassages(editor.getJSON())).toEqual([expect.objectContaining({ text: 'Alpha beta', relation: 'example', topicId: 'p' })])
  })
})

it('links only an unchanged selection to its saved quotation and removes the annotation if its wording is edited', async () => {
  const content = doc('The original wording.')
  await render({ content })
  const selection = { doc: editor.state.doc, from: 5, to: 13, text: 'original' }
  expect(linkSavedQuote(editor, selection, 'quote-1', 'different')).toBe(false)
  act(() => { expect(linkSavedQuote(editor, selection, 'quote-1', 'original')).toBe(true) })
  expect(validateWritingContent(editor.getJSON())).toEqual(expect.objectContaining({ type: 'doc' }))
  const saved = editor.view.dom.querySelector<HTMLAnchorElement>('[data-saved-quote]')!
  expect(saved.textContent).toBe('original')
  expect(saved.getAttribute('href')).toBe('#/quotes?quote=quote-1')
  const authorship = writingAuthorshipMessages(editor.getJSON())
  expect(authorship.filter(message => message.role === 'third-party').map(message => message.text)).toEqual(['original'])
  act(() => editor.view.dispatch(editor.state.tr.insertText('x', 8)))
  expect(editor.view.dom.querySelector('[data-saved-quote]')).toBeNull()
  expect(linkSavedQuote(editor, selection, 'quote-2', 'original')).toBe(false)
})
