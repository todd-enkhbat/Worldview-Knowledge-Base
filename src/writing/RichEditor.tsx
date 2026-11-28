import { SelectionConcepts, type ConceptActions } from './SelectionConcepts.tsx'
import type { ConceptTerm } from './concepts.ts'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import type { ChainedCommands } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'
import { ArrowClockwise, ArrowCounterClockwise, Code, Image, Link as LinkIcon, LinkBreak, ListBullets, ListNumbers, Minus, MusicNote, TextAlignCenter, TextAlignJustify, TextAlignLeft, TextAlignRight, TextB, TextItalic, TextStrikethrough, TextUnderline, VideoCamera, X, ArrowUp, ArrowDown, DotsSixVertical, Highlighter, Scribble, ListDashes, TextAa, CaretDown } from '@phosphor-icons/react'
import { emptyWritingContent, safeWritingLink, validateWritingContent } from './model.ts'
import { parseWritingEmbed } from './media.ts'
import type { WritingNode } from './types.ts'
import { normalizedWritingJSON, sanitizeWritingPasteHTML, WRITING_EXTERNAL_UPDATE, writingExtensions, writingSections, moveWritingSection } from './extensions.ts'
import './richEditor.css'

export interface RichEditorProps {
  documentId: string
  ariaLabel?: string
  content: WritingNode
  onChange: (content: WritingNode) => void
  variant?: 'document' | 'source' | 'notebook'
  editable?: boolean
  preview?: boolean
  header?: ReactNode
  footer?: ReactNode
  onReady?: (editor: Editor) => void
  onUpload?: (files: File[], editor: Editor) => Promise<void>
  onInsertEmbed?: (editor: Editor) => void
  topics?: ConceptTerm[]
  conceptActions?: ConceptActions
}
type SlashState = { from: number; to: number; query: string; active: number }
type MenuCommand = { id: string; label: string; hint: string; run: (editor: Editor) => void }
type Bookmark = ReturnType<Selection['toJSON']>
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// Small signatures retain autosave echo identity without holding many full documents.
function signature(content: WritingNode): string {
  const text = JSON.stringify(content, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  let a = 2166136261, b = 5381
  for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); a = Math.imul(a ^ code, 16777619); b = Math.imul(b, 33) ^ code }
  return `${text.length}:${a >>> 0}:${b >>> 0}`
}

/** Document identity owns editor/history. Same-document autosave echoes never reset it. */
export function RichEditor(props: RichEditorProps) { return <EditorSession key={props.documentId} {...props} /> }
export default RichEditor

function EditorSession({ content, onChange, ariaLabel, variant = 'document', editable = true, preview = false, header, footer, onReady, onUpload, onInsertEmbed, topics = [], conceptActions }: RichEditorProps) {
  const notebook = variant === 'notebook'
  const source = variant === 'source'
  const hasConcepts = !!conceptActions
  const initial = useRef<WritingNode | null>(null)
  if (!initial.current) { try { initial.current = validateWritingContent(normalizedWritingJSON(content)) } catch { initial.current = emptyWritingContent() } }
  const saved = useRef(initial.current), bookmark = useRef<Bookmark | null>(null), touched = useRef(false)
  const acceptedProp = useRef(signature(initial.current)), echoes = useRef(new Set<string>())
  const mounted = useRef(false), activeEditor = useRef<Editor | null>(null)
  const callbacks = useRef({ onChange, onReady, onUpload, onInsertEmbed, canEdit: editable && !preview })
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [uploading, setUploading] = useState(false)
  const [incoming, setIncoming] = useState<WritingNode | null>(null)
  const [dialog, setDialog] = useState<'link' | 'embed' | 'footnote' | null>(null), [url, setUrl] = useState('')
  const urlInput = useRef<HTMLInputElement | HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null)
  const topicsRef = useRef(topics)
  const conceptButton = useRef<HTMLButtonElement>(null)
  const selectionMenu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { topicsRef.current = topics }, [topics])
  const extensions = useMemo(() => writingExtensions({ topics: () => topicsRef.current, placeholder: notebook ? 'Write a reading note…' : undefined }), [notebook])
  const dialogId = useId()
  const [slash, setSlash] = useState<SlashState | null>(null), [bubble, setBubble] = useState<{ top: number; bottom: number; center: number } | null>(null), [slashPosition, setSlashPosition] = useState<{ top: number; left: number } | null>(null)
  const [showSections, setShowSections] = useState(false), [sectionVersion, setSectionVersion] = useState(0)
  const sectionOpen = useRef(false)
  useLayoutEffect(() => { sectionOpen.current = showSections }, [showSections])
  const [uploadProgress, setUploadProgress] = useState<{ complete: number; total: number; name: string } | null>(null)
  const slashState = useRef<SlashState | null>(null), slashCommands = useRef<MenuCommand[]>([]), slashHandler = useRef<((event: KeyboardEvent) => boolean) | null>(null), slashDismissed = useRef(''), draggedSection = useRef<number | null>(null)
  const setSlashMenu = useCallback((value: SlashState | null) => { slashState.current = value; setSlash(value) }, [])
  const updateOverlays = useCallback((current: Editor) => {
    if (current.isDestroyed || !callbacks.current.canEdit) { setBubble(null); setSlashMenu(null); return }
    const { selection } = current.state
    if (!selection.empty && !('node' in selection)) {
      try {
        const start = current.view.coordsAtPos(selection.from), end = current.view.coordsAtPos(selection.to)
        setBubble({ top: start.top, bottom: end.bottom, center: (start.left + end.left) / 2 })
      } catch { setBubble(null) }
    } else setBubble(null)
    if (!selection.empty || !selection.$from.parent.isTextblock || current.isActive('codeBlock')) { setSlashMenu(null); return }
    const text = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\ufffc'), match = /^\/([\w -]{0,35})$/.exec(text)
    if (!match) { slashDismissed.current = ''; setSlashMenu(null); return }
    const next = { from: selection.from - text.length, to: selection.from, query: match[1].toLowerCase(), active: 0 }, identity = `${next.from}:${next.to}:${next.query}`
    if (slashDismissed.current === identity) return
    if (slashState.current?.query === next.query) next.active = slashState.current.active
    setSlashMenu(next)
    try { const rect = current.view.coordsAtPos(selection.from); setSlashPosition({ top: Math.min(window.innerHeight - 285, Math.max(8, rect.bottom + 8)), left: Math.max(12, Math.min(window.innerWidth - 285, rect.left)) }) } catch { setSlashPosition({ top: 140, left: 20 }) }
  }, [setSlashMenu])
  useLayoutEffect(() => {
    const menu = selectionMenu.current
    if (!menu || !bubble) return
    function position() {
      if (!menu || !bubble || getComputedStyle(menu).position !== 'fixed') return
      // Anchor to the visible modal as well as the viewport. Subtract the actual
      // fixed positioning origin when an ancestor establishes its own coordinate space.
      const modal = menu.closest('dialog[open]')?.getBoundingClientRect()
      const left = Math.max(0, modal?.left ?? 0) + 8, right = Math.min(window.innerWidth, modal?.right ?? window.innerWidth) - 8
      const tools = menu.parentElement?.querySelector('.writing-tools')?.getBoundingClientRect()
      const top = Math.max(0, modal?.top ?? 0, tools?.bottom ?? 0) + 8
      const bottom = Math.min(window.innerHeight, modal?.bottom ?? window.innerHeight) - 8
      menu.style.maxWidth = Math.max(0, right - left) + 'px'
      menu.style.maxHeight = Math.max(0, bottom - top) + 'px'
      menu.style.left = '0px'; menu.style.top = '0px'
      const rect = menu.getBoundingClientRect()
      const x = Math.max(left, Math.min(right - rect.width, bubble.center - rect.width / 2))
      const preferredY = bubble.top - rect.height - 6
      const y = Math.max(top, Math.min(bottom - rect.height, preferredY >= top ? preferredY : bubble.bottom + 6))
      menu.style.left = (x - rect.left) + 'px'; menu.style.top = (y - rect.top) + 'px'
    }
    position()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null
    observer?.observe(menu)
    return () => { observer?.disconnect(); menu.style.removeProperty('max-width'); menu.style.removeProperty('max-height'); menu.style.removeProperty('left'); menu.style.removeProperty('top') }
  }, [bubble, dialog])
  useLayoutEffect(() => { callbacks.current = { onChange, onReady, onUpload, onInsertEmbed, canEdit: editable && !preview } }, [onChange, onReady, onUpload, onInsertEmbed, editable, preview])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function remember(editor: Editor) { bookmark.current = editor.state.selection.toJSON() }
  function restore(editor: Editor) {
    if (!bookmark.current) return
    try { editor.view.dispatch(editor.state.tr.setSelection(Selection.fromJSON(editor.state.doc, bookmark.current))) } catch { bookmark.current = editor.state.selection.toJSON() }
  }
  async function upload(files: File[], editor: Editor) {
    if (!files.length || editor.isDestroyed || !callbacks.current.canEdit) return
    if (!callbacks.current.onUpload) { setError('Media uploads are unavailable in this view.'); return }
    if (files.length > 32) { setError('Insert up to 32 files at a time.'); return }
    restore(editor); setUploading(true); setError(''); setNotice('')
    try { for (let index = 0; index < files.length; index++) { if (!mounted.current || editor.isDestroyed || !callbacks.current.canEdit) throw new Error('Reopen this document before inserting more media.'); setUploadProgress({ complete: index, total: files.length, name: files[index].name }); await callbacks.current.onUpload([files[index]], editor); if (mounted.current) setUploadProgress({ complete: index + 1, total: files.length, name: files[index].name }) } if (mounted.current && !editor.isDestroyed) setNotice(`${files.length === 1 ? 'Media' : `${files.length} media files`} inserted.`) }
    catch (failure) { if (mounted.current) setError(message(failure)) }
    finally { if (mounted.current) { setUploading(false); setUploadProgress(null) } }
  }
  const editor = useEditor({
    extensions, content: saved.current, editable: editable && !preview,
    immediatelyRender: false, shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'writing-rich-body', role: 'textbox', 'aria-label': ariaLabel ?? (notebook ? 'Reading note' : 'Document body'), 'aria-multiline': 'true', 'aria-readonly': String(!editable || preview), spellcheck: 'true' },
      transformPastedHTML(html) {
        if (/<(?:img|iframe|video|audio|object|embed|svg)\b/i.test(html)) setNotice('Pasted remote media was omitted. Upload a local file or use a video link.')
        return sanitizeWritingPasteHTML(html)
      },
      handleDOMEvents: {
        keydown(view, event) {
          // Skip ProseMirror's parent-node shortcut when the notebook dialog can handle Escape.
          return notebook && event.key === 'Escape' && !event.isComposing && view.state.selection.empty &&
            !slashState.current && !urlInput.current && !!view.dom.closest('dialog[open]')
        },
        contextmenu(view,event) {
          if(view.state.selection.empty || !activeEditor.current) return false
          event.preventDefault();updateOverlays(activeEditor.current);requestAnimationFrame(()=>conceptButton.current?.focus());return true
        },
      },
      handleKeyDown(_view, event) {
        if (conceptButton.current && !event.isComposing) {
          if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
            event.preventDefault(); conceptButton.current.click(); return true
          }

        }
        if ((event.altKey || event.shiftKey) && event.key === 'F10' || event.key === 'ContextMenu') {
          const command = conceptButton.current ?? selectionMenu.current?.querySelector<HTMLElement>('button')
          if (command) { event.preventDefault(); command.focus(); return true }
        }
        if (event.key === 'Escape' && !slashState.current) setBubble(null)
        return slashHandler.current?.(event) ?? false
      },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files ?? [])]
        if (!files.length) return false
        event.preventDefault()
        const current = activeEditor.current
        if (current) { remember(current); void upload(files, current) }
        return true
      },
      handleDrop(view, event) {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (!files.length) return false
        event.preventDefault()
        const current = activeEditor.current
        if (current && callbacks.current.canEdit) {
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (position) current.commands.setTextSelection(position.pos)
          remember(current); void upload(files, current)
        }
        return true
      },
    },
    onCreate({ editor: created }) {
      if (created.isDestroyed) return
      activeEditor.current = created
      // Activity can destroy an effect-owned editor while retaining this component.
      // Rehydrate its last local JSON and selection, not a possibly stale autosave echo.
      if (signature(normalizedWritingJSON(created.getJSON())) !== signature(saved.current!)) created.chain().setMeta(WRITING_EXTERNAL_UPDATE, true).setContent(saved.current!, { emitUpdate: false }).run()
      restore(created)
      // The initial useEditorState snapshot can precede EditorContent mounting its
      // editable view. Notify subscribers without changing the document or history.
      created.view.dispatch(created.state.tr.setMeta('writing:ready', true))
      if (mounted.current) callbacks.current.onReady?.(created)
    },
    onBlur({ event }) { const target = event.relatedTarget; if (!(target instanceof Element) || !target.closest('.writing-selection-menu,.writing-rich-toolbar,.writing-editor-link-form,.writing-slash-menu')) { setBubble(null); setSlashMenu(null) } },
    onSelectionUpdate({ editor: current }) { remember(current); updateOverlays(current) },
    onTransaction({ editor: current, transaction }) { if (transaction.docChanged && mounted.current) { updateOverlays(current); if (sectionOpen.current) setSectionVersion((version) => version + 1) } },
    onUpdate({ editor: current }) {
      if (!mounted.current || !callbacks.current.canEdit || current.isDestroyed) return
      const next = normalizedWritingJSON(current.getJSON())
      try {
        validateWritingContent(next)
        saved.current = next; touched.current = true; remember(current)
        echoes.current.add(signature(next))
        if (echoes.current.size > 128) echoes.current.delete(echoes.current.values().next().value!)
        callbacks.current.onChange(next)
      } catch (failure) { setError(message(failure)) }
    },
  }, [])

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('writing:topic-terms', true))
  }, [editor, topics])
  useEffect(() => {
    if (!editable || preview) { setDialog(null); setBubble(null); setSlashMenu(null); setShowSections(false) }
    if (!editor || editor.isDestroyed) return
    activeEditor.current = editor
    const next = editable && !preview
    if (editor.isEditable !== next) {
      editor.setEditable(next, false)
      editor.view.dispatch(editor.state.tr.setMeta('writing:editable-state', true))
    }
    editor.view.dom.setAttribute('aria-readonly', String(!editable || preview))
  }, [editor, editable, preview, setSlashMenu])
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    let next: WritingNode
    try { next = validateWritingContent(normalizedWritingJSON(content)) } catch (failure) { setError(message(failure)); return }
    const nextSignature = signature(next)
    if (acceptedProp.current === nextSignature) return
    acceptedProp.current = nextSignature
    if (echoes.current.has(nextSignature) || nextSignature === signature(normalizedWritingJSON(editor.getJSON()))) { setIncoming(null); return }
    if (touched.current) { setIncoming(next); return }
    editor.chain().setMeta(WRITING_EXTERNAL_UPDATE, true).setContent(next, { emitUpdate: false }).run()
    saved.current = normalizedWritingJSON(editor.getJSON()); bookmark.current = null
  }, [content, editor])
  useEffect(() => { if (dialog) urlInput.current?.focus() }, [dialog])

  function apply(action: (chain: ChainedCommands) => ChainedCommands) {
    if (!editor || editor.isDestroyed || !editable || preview) return
    restore(editor)
    action(editor.chain().focus(undefined, { scrollIntoView: false })).run()
    remember(editor)
  }
  function openLink() { if (!editor) return; remember(editor); setUrl(String(editor.getAttributes('link').href ?? '')); setDialog('link'); setError('') }
  function closeDialog() { setDialog(null); if (editor && !editor.isDestroyed) { restore(editor); editor.commands.focus(undefined, { scrollIntoView: false }) } }
  function submitUrl(event: FormEvent) {
    event.preventDefault()
    if (dialog === 'footnote') {
      if (!url.trim()) { setError('Write a note before inserting it.'); return }
      apply((chain) => editor?.isActive('writingFootnote') ? chain.updateAttributes('writingFootnote', { text: url.trim() }) : chain.insertContent({ type: 'writingFootnote', attrs: { id: crypto.randomUUID(), text: url.trim() } }))
    } else if (dialog === 'embed') {
      const embed = parseWritingEmbed(url)
      if (!embed) { setError('Use a public YouTube or Vimeo video URL.'); return }
      apply((chain) => chain.insertContent({ type: 'writingEmbed', attrs: { url: embed.url, provider: embed.provider } }))
    } else {
      const value = url.trim()
      const href = /^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(value) ? `https://${value}` : value
      if (!safeWritingLink(href)) { setError('Use an HTTP, HTTPS, or mailto link without embedded credentials.'); return }
      apply((chain) => chain.extendMarkRange('link').setLink({ href }))
    }
    setError(''); closeDialog()
  }
  function pickMedia(kind: 'image' | 'video' | 'audio') {
    if (!editor || !fileInput.current) return
    remember(editor); fileInput.current.accept = `${kind}/*`; fileInput.current.click()
  }
  function footnote() { if (!editor) return; remember(editor); setUrl(String(editor.getAttributes('writingFootnote').text ?? '')); setDialog('footnote'); setError('') }
  function insertSketch() {
    if (!editor) return
    restore(editor)
    // Drawings occupy their own block. Keep the sentence and its formatting intact.
    const { $to, to } = editor.state.selection
    const position = $to.parent.isTextblock && $to.parent.content.size ? $to.after() : to
    editor.chain().focus().insertContentAt(position, { type: 'writingSketch', attrs: { title: '', strokes: [] } }).run()
    remember(editor)
  }
  const commands: MenuCommand[] = [
    { id: 'text', label: 'Normal text', hint: 'A paragraph', run: (current) => current.chain().focus().setParagraph().run() },
    { id: 'h1', label: 'Heading 1', hint: 'A major section', run: (current) => current.chain().focus().setHeading({ level: 1 }).run() },
    { id: 'h2', label: 'Heading 2', hint: 'A smaller section', run: (current) => current.chain().focus().setHeading({ level: 2 }).run() },
    { id: 'bullet', label: 'Bullet list', hint: 'Collect a few ideas', run: (current) => current.chain().focus().toggleBulletList().run() },
    { id: 'ordered', label: 'Numbered list', hint: 'One step at a time', run: (current) => current.chain().focus().toggleOrderedList().run() },
    { id: 'quote', label: 'Blockquote', hint: 'Indent a passage', run: (current) => current.chain().focus().setBlockquote().run() },
    { id: 'table', label: 'Table', hint: 'Compare and organize', run: (current) => current.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'sketch', label: 'Sketch', hint: 'Draw freehand', run: insertSketch },
    { id: 'divider', label: 'Divider', hint: 'A quiet pause', run: (current) => current.chain().focus().setHorizontalRule().run() },
    { id: 'footnote', label: 'Footnote', hint: 'Keep an aside', run: footnote },
    { id: 'image', label: 'Image', hint: 'Upload an original', run: () => pickMedia('image') },
    { id: 'video', label: 'Video', hint: 'Upload a video', run: () => pickMedia('video') },
  ]
  const matchingCommands = commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(slash?.query ?? ''))
  slashCommands.current = matchingCommands
  function executeSlash(command: MenuCommand) { if (!editor || !slashState.current || !editable || preview) return; const range = slashState.current; editor.chain().focus().deleteRange({ from: range.from, to: range.to }).run(); remember(editor); setSlashMenu(null); command.run(editor) }
  slashHandler.current = (event) => {
    const menu = slashState.current
    if (!menu || !callbacks.current.canEdit) return false
    const list = slashCommands.current
    if (event.key === 'Escape') { event.preventDefault(); slashDismissed.current = `${menu.from}:${menu.to}:${menu.query}`; setSlashMenu(null); return true }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const active = event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, list.length - 1) : (menu.active + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, list.length)) % Math.max(1, list.length); setSlashMenu({ ...menu, active }); return true }
    if (event.key === 'Enter' && list.length) { event.preventDefault(); executeSlash(list[Math.min(menu.active, list.length - 1)]); return true }
    return false
  }
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const node = editor.view.dom
    if (slash) { node.setAttribute('aria-controls', `${dialogId}-slash`); node.setAttribute('aria-autocomplete', 'list'); if (matchingCommands.length) node.setAttribute('aria-activedescendant', `${dialogId}-slash-${matchingCommands[Math.min(slash.active, matchingCommands.length - 1)].id}`); else node.removeAttribute('aria-activedescendant') }
    else { node.removeAttribute('aria-controls'); node.removeAttribute('aria-autocomplete'); node.removeAttribute('aria-activedescendant') }
  }, [editor, slash, dialogId, matchingCommands])
  useEffect(() => { if (!editor) return; const reposition = () => { if (!editor.isDestroyed && (editor.isFocused || conceptButton.current?.closest('.writing-selection-menu')?.contains(document.activeElement))) updateOverlays(editor); else setBubble(null) }; document.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition); return () => { document.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) } }, [editor, updateOverlays])
  const sections = showSections && editor && !editor.isDestroyed ? writingSections(editor) : []
  void sectionVersion
  return <div className={`writing-rich-editor ${notebook ? 'is-notebook' : source ? 'is-source' : ''} ${preview ? 'is-preview' : ''}`}>
    {!preview && <WritingToolbar notebook={notebook} hasConcepts={hasConcepts} editor={editor} disabled={!editable} uploading={uploading} canUpload={!!onUpload} remember={() => { if (editor) remember(editor) }} apply={apply} onLink={openLink} onFootnote={footnote} onSketch={insertSketch} showSections={showSections} onSections={() => setShowSections((value) => !value)} onPickMedia={pickMedia} onEmbed={() => {
      if (!editor) return
      remember(editor)
      if (callbacks.current.onInsertEmbed) { restore(editor); callbacks.current.onInsertEmbed(editor) }
      else { setDialog('embed'); setUrl(''); setError('') }
    }} />}
    {bubble && editable && !preview && !dialog && <div ref={selectionMenu} className={`writing-selection-menu ${hasConcepts ? 'has-concepts' : ''}`} role="toolbar" aria-label="Selection formatting" onPointerDownCapture={() => { if (editor) remember(editor) }} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); editor?.commands.focus(undefined, { scrollIntoView: false }); setBubble(null) }
    }}>
      {editor && conceptActions && <SelectionConcepts editor={editor} actions={conceptActions} primaryRef={conceptButton} onMessage={setNotice} />}
      {(!notebook || !hasConcepts) && <div className="writing-selection-format">{[['Bold', TextB, () => apply((chain) => chain.toggleBold())], ['Italic', TextItalic, () => apply((chain) => chain.toggleItalic())], ['Highlight', Highlighter, () => apply((chain) => chain.toggleHighlight({ color: '#fff2a8' }))]].map(([label, Icon, action]) => {
        const Symbol = Icon as typeof TextB
        return <button key={String(label)} type="button" aria-label={`Selection ${label}`} aria-pressed={label === 'Bold' ? editor?.isActive('bold') : label === 'Italic' ? editor?.isActive('italic') : label === 'Highlight' ? editor?.isActive('highlight') : undefined} title={String(label)} onMouseDown={event => event.preventDefault()} onClick={action as () => void}><Symbol size={17} aria-hidden="true" /></button>
      })}<label className="writing-selection-color" title="Choose highlight color"><CaretDown size={12} /><select aria-label="Selection highlight color" value={editor?.getAttributes('highlight').color ?? ''} onChange={e => { const color = e.target.value; apply(chain => color ? chain.unsetBackgroundColor().setHighlight({ color }) : chain.unsetHighlight().unsetBackgroundColor()) }}>
        <option value="">No highlight</option>{highlights.map(([name, color]) => <option key={color} value={color}>{name}</option>)}</select></label>
        <button type="button" aria-label="Selection Link" title="Link" onMouseDown={e => e.preventDefault()} onClick={openLink}><LinkIcon size={17} aria-hidden="true" /></button>
        <label className="writing-text-color" title="Selection text color"><span>A</span><input type="color" aria-label="Selection text color" value={/^#[a-f0-9]{6}$/i.test(editor?.getAttributes('textStyle').color ?? '') ? editor?.getAttributes('textStyle').color : '#292624'} onChange={e => { const color = e.target.value; apply(chain => chain.setColor(color)) }} /></label>
      </div>}
    </div>}
    {slash && slashPosition && editable && !preview && <div className="writing-slash-menu" id={`${dialogId}-slash`} role="listbox" aria-label="Insert a block" style={slashPosition}><span className="writing-slash-label">Insert a block</span>{matchingCommands.length ? matchingCommands.map((command, index) => <button key={command.id} id={`${dialogId}-slash-${command.id}`} type="button" role="option" aria-selected={Math.min(slash.active, matchingCommands.length - 1) === index} onMouseDown={(event) => event.preventDefault()} onClick={() => executeSlash(command)}><strong>{command.label}</strong><small>{command.hint}</small></button>) : <p>No matching blocks.</p>}<span className="writing-slash-help">↑ ↓ to choose · Enter to insert · Esc to close</span></div>}
    {showSections && !preview && <section className="writing-section-order" aria-label="Reorder document sections"><header><strong>Sections</strong><span>Drag a handle or use the arrows.</span><button type="button" aria-label="Close section ordering" onClick={() => setShowSections(false)}><X size={15} aria-hidden="true" /></button></header>{sections.map((section, index) => <div key={`${section.from}:${section.title}`} onDragOver={(event) => { if (draggedSection.current !== null) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); if (editor && draggedSection.current !== null) moveWritingSection(editor, draggedSection.current, index); draggedSection.current = null }}><button type="button" draggable={editable} disabled={!editable} aria-label={`Drag section ${section.title}`} title="Drag this section" onDragStart={(event) => { draggedSection.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', section.title) }} onDragEnd={() => { draggedSection.current = null }}><DotsSixVertical size={18} aria-hidden="true" /></button><span>{section.title}</span><button type="button" disabled={!editable || index === 0} aria-label={`Move ${section.title} up`} onClick={() => { if (editor) moveWritingSection(editor, index, index - 1) }}><ArrowUp size={16} aria-hidden="true" /></button><button type="button" disabled={!editable || index === sections.length - 1} aria-label={`Move ${section.title} down`} onClick={() => { if (editor) moveWritingSection(editor, index, index + 1) }}><ArrowDown size={16} aria-hidden="true" /></button></div>)}</section>}
    {uploadProgress && <div className="writing-upload-progress" role="status"><span>Retaining {uploadProgress.name}</span><progress aria-label="Media files retained" value={uploadProgress.complete} max={uploadProgress.total} /><small>{uploadProgress.complete} of {uploadProgress.total} saved locally</small></div>}
    <input ref={fileInput} hidden type="file" multiple aria-label="Upload document media" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (editor) void upload(files, editor) }} />
    {incoming && <div className="writing-editor-conflict" role="alert"><p>Another version of this document arrived. Your current edits are still here.</p><div><button type="button" disabled={!editable || preview} onClick={() => { if (!editor || !editable || preview) return; const next = normalizedWritingJSON(editor.getJSON()); saved.current = next; setIncoming(null); callbacks.current.onChange(next) }}>Keep my version</button><button type="button" onClick={() => { if (!editor) return; editor.chain().setMeta(WRITING_EXTERNAL_UPDATE, true).setContent(incoming, { emitUpdate: false }).run(); saved.current = normalizedWritingJSON(editor.getJSON()); touched.current = false; bookmark.current = null; setIncoming(null) }}>Load incoming version</button></div></div>}
    {(error || notice) && <div className={`writing-editor-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button type="button" aria-label="Dismiss editor message" onClick={() => { setError(''); setNotice('') }}><X size={15} aria-hidden="true" /></button></div>}
    {dialog && !preview && <form className="writing-editor-link-form" onSubmit={submitUrl} aria-labelledby={dialogId} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog() } }}><label id={dialogId} htmlFor={`${dialogId}-url`}>{dialog === 'footnote' ? 'Footnote' : dialog === 'embed' ? 'YouTube or Vimeo URL' : 'Link URL'}</label>{dialog === 'footnote' ? <textarea id={`${dialogId}-url`} ref={(element) => { urlInput.current = element }} value={url} onChange={(event) => setUrl(event.target.value)} maxLength={20000} rows={3} placeholder="A source, an aside, a little context…" /> : <input id={`${dialogId}-url`} ref={(element) => { urlInput.current = element }} value={url} onChange={(event) => setUrl(event.target.value)} type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://…" />}<button type="submit" disabled={!url.trim()}>{dialog === 'footnote' ? 'Save footnote' : dialog === 'embed' ? 'Insert video' : 'Apply link'}</button>{dialog === 'link' && <button type="button" onClick={() => { apply((chain) => chain.extendMarkRange('link').unsetLink()); closeDialog() }}>Remove link</button>}<button type="button" aria-label="Close link form" onClick={closeDialog}><X size={17} aria-hidden="true" /></button></form>}
    <div className="writing-editor-page">{header}<EditorContent editor={editor} className="writing-editor-content" />{footer}</div>
  </div>
}

const highlights = [['Yellow', '#fff2a8'], ['Blue', '#bfdbfe'], ['Rose', '#fecdd3'], ['Green', '#bbf7d0']]
function WritingToolbar({ notebook, hasConcepts, editor, disabled, uploading, canUpload, remember, apply, onLink, onFootnote, onSketch, showSections, onSections, onPickMedia, onEmbed }: { notebook: boolean; hasConcepts: boolean; editor: Editor | null; disabled: boolean; uploading: boolean; canUpload: boolean; remember: () => void; apply: (action: (chain: ChainedCommands) => ChainedCommands) => void; onLink: () => void; onFootnote: () => void; onSketch: () => void; showSections: boolean; onSections: () => void; onPickMedia: (kind: 'image' | 'video' | 'audio') => void; onEmbed: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const tools = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), trayId = useId()
  useEffect(() => {
    if (!expanded) return
    const outside = (event: PointerEvent) => { if (!tools.current?.contains(event.target as globalThis.Node)) setExpanded(false) }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); toggle.current?.focus(); event.preventDefault() } }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape) }
  }, [expanded])
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), strike: current.isActive('strike'), code: current.isActive('code'), bullet: current.isActive('bulletList'), ordered: current.isActive('orderedList'), link: current.isActive('link'),
    block: current.isActive('codeBlock') ? 'code' : current.isActive('blockquote') ? 'quote' : current.isActive('heading') ? `h${current.getAttributes('heading').level}` : 'paragraph',
    alignment: current.getAttributes('paragraph').textAlign ?? current.getAttributes('heading').textAlign ?? 'left', family: String(current.getAttributes('textStyle').fontFamily ?? ''), size: String(current.getAttributes('textStyle').fontSize ?? ''), color: String(current.getAttributes('textStyle').color ?? '#292624'), highlight: String(current.getAttributes('highlight').color ?? current.getAttributes('textStyle').backgroundColor ?? ''),
    table: current.isActive('table'), undo: current.can().undo(), redo: current.can().redo(), editable: current.isEditable,
  } : null })
  // Prop editability is authoritative. A pre-mount cached selector value must not
  // leave a new, empty document's toolbar locked until its first typed transaction.
  const off = disabled || !editor || editor.isDestroyed
  function icon(label: string, Icon: typeof TextB, action: () => void, pressed?: boolean, unavailable = false) {
    return <button type="button" className="writing-format-button" aria-label={label} title={label} aria-pressed={pressed} disabled={off || unavailable} onMouseDown={(event) => event.preventDefault()} onClick={action}><Icon size={18} aria-hidden="true" /></button>
  }
  if (notebook) return <div className="writing-notebook-toolbar" role="group" aria-label="Note formatting" onPointerDownCapture={remember}>
    {icon('Bold', TextB, () => apply(chain => chain.toggleBold()), state?.bold)}
    {icon('Italic', TextItalic, () => apply(chain => chain.toggleItalic()), state?.italic)}
    {icon('Bullet list', ListBullets, () => apply(chain => chain.toggleBulletList()), state?.bullet)}
    {hasConcepts && !disabled && <small>Select words to make a concept.</small>}
  </div>
  const fonts = [{ value: '', label: 'Document font' }, { value: 'Georgia, serif', label: 'Georgia' }, { value: 'Palatino, serif', label: 'Palatino' }, { value: 'Alte Haas, Helvetica, sans-serif', label: 'Alte Haas' }, { value: 'Helvetica Neue, sans-serif', label: 'Helvetica Neue' }, { value: 'Menlo, monospace', label: 'Menlo' }]
  const sizes = ['', '8px', '10px', '11px', '12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px', '40px', '48px', '64px', '72px', '96px']
  return <div ref={tools} className={`writing-rich-toolbar writing-tools ${expanded ? 'is-expanded' : ''}`} role="group" aria-label="Document formatting" onPointerDownCapture={remember} onFocusCapture={remember}
    onBlur={e => { if (e.relatedTarget instanceof Element && !e.currentTarget.contains(e.relatedTarget) && !editor?.view.dom.contains(e.relatedTarget)) setExpanded(false) }}>
    <div className="writing-tools-line">
      <select aria-label="Text style" disabled={off} value={state?.block ?? 'paragraph'} onChange={(event) => {
      const block = event.target.value
      apply((chain) => {
        if (block !== 'quote' && editor?.isActive('blockquote')) chain = chain.lift('blockquote')
        return block === 'quote' ? chain.setParagraph().setBlockquote() : block === 'code' ? chain.setCodeBlock() : block.startsWith('h') ? chain.setHeading({ level: Number(block.slice(1)) as 1 | 2 | 3 }) : chain.setParagraph()
      })
    }}><option value="paragraph">Normal text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>{state?.block && /^h[4-6]$/.test(state.block) && <option value={state.block}>Heading {state.block.slice(1)}</option>}<option value="quote">Blockquote</option><option value="code">Code block</option></select>
      <button ref={toggle} type="button" className="writing-tool-label" aria-label="More formatting" aria-expanded={expanded} aria-controls={trayId} disabled={off} onClick={() => setExpanded(!expanded)}><TextAa size={17} />Format<CaretDown size={11} /></button>
      <button className="writing-tool-label" type="button" disabled={off} onMouseDown={e => e.preventDefault()} onClick={onSketch}><Scribble size={17} />Sketch</button>
      <button className="writing-tool-label" type="button" aria-label="Reorder sections" aria-expanded={showSections} disabled={off} onMouseDown={e => e.preventDefault()} onClick={onSections}><ListDashes size={16} />Sections</button>
    </div>
    <div className="writing-tools-tray" id={trayId} hidden={!expanded}>
    <div className="writing-toolbar-group"><select aria-label="Font family" disabled={off} value={state?.family ?? ''} onChange={(event) => { const value = event.target.value; apply((chain) => value ? chain.setFontFamily(value) : chain.unsetFontFamily()) }}>{state?.family && !fonts.some((font) => font.value === state.family) && <option value={state.family}>{state.family}</option>}{fonts.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select><select aria-label="Font size" className="writing-font-size" disabled={off} value={state?.size ?? ''} onChange={(event) => { const value = event.target.value; apply((chain) => value ? chain.setFontSize(value) : chain.unsetFontSize()) }}>{state?.size && !sizes.includes(state.size) && <option value={state.size}>{state.size.replace('px', '')}</option>}{sizes.map((size) => <option key={size} value={size}>{size ? size.replace('px', '') : 'Size'}</option>)}</select></div>
    <div className="writing-toolbar-group">{icon('Bold', TextB, () => apply((chain) => chain.toggleBold()), state?.bold)}{icon('Italic', TextItalic, () => apply((chain) => chain.toggleItalic()), state?.italic)}{icon('Underline', TextUnderline, () => apply((chain) => chain.toggleUnderline()), state?.underline)}{icon('Strikethrough', TextStrikethrough, () => apply((chain) => chain.toggleStrike()), state?.strike)}{icon('Inline code', Code, () => apply((chain) => chain.toggleCode()), state?.code)}<label className="writing-text-color" title="Text color"><span>A</span><input type="color" aria-label="Text color" disabled={off} value={/^#[a-f\d]{6}$/i.test(state?.color ?? '') ? state!.color : '#292624'} onChange={(event) => { const value = event.target.value; apply((chain) => chain.setColor(value)) }} /></label><select className="writing-highlight-color" aria-label="Highlight color" disabled={off} value={state?.highlight ?? ''} onChange={(event) => { const value = event.target.value; apply((chain) => value ? chain.unsetBackgroundColor().setHighlight({ color: value }) : chain.unsetHighlight().unsetBackgroundColor()) }}>{state?.highlight && !['#fff2a8', '#bfdbfe', '#fecdd3', '#bbf7d0'].includes(state.highlight) && <option value={state.highlight}>Custom highlight</option>}<option value="">Highlight</option><option value="#fff2a8">Yellow</option><option value="#bfdbfe">Blue</option><option value="#fecdd3">Rose</option><option value="#bbf7d0">Green</option></select><label className="writing-text-color" title="Custom highlight"><Highlighter size={17}/><input type="color" aria-label="Custom highlight color" disabled={off} value={/^#[a-f0-9]{6}$/i.test(state?.highlight ?? '') ? state!.highlight : '#fff2a8'} onChange={e => { const color = e.target.value; apply(chain => chain.unsetBackgroundColor().setHighlight({ color })) }} /></label></div>
    <div className="writing-toolbar-group writing-toolbar-secondary">{icon('Bullet list', ListBullets, () => apply((chain) => chain.toggleBulletList()), state?.bullet)}{icon('Numbered list', ListNumbers, () => apply((chain) => chain.toggleOrderedList()), state?.ordered)}{icon('Align left', TextAlignLeft, () => apply((chain) => chain.setTextAlign('left')), state?.alignment === 'left')}{icon('Align center', TextAlignCenter, () => apply((chain) => chain.setTextAlign('center')), state?.alignment === 'center')}{icon('Align right', TextAlignRight, () => apply((chain) => chain.setTextAlign('right')), state?.alignment === 'right')}{icon('Justify text', TextAlignJustify, () => apply((chain) => chain.setTextAlign('justify')), state?.alignment === 'justify')}</div>
    <div className="writing-toolbar-group">{icon('Edit link', LinkIcon, onLink, state?.link)}{icon('Unlink', LinkBreak, () => apply((chain) => chain.extendMarkRange('link').unsetLink()), undefined, !state?.link)}{icon('Insert divider', Minus, () => apply((chain) => chain.setHorizontalRule()))}</div>
    <div className="writing-toolbar-group writing-toolbar-secondary">{icon('Insert image', Image, () => onPickMedia('image'), undefined, !canUpload || uploading)}{icon('Insert video file', VideoCamera, () => onPickMedia('video'), undefined, !canUpload || uploading)}{icon('Insert audio file', MusicNote, () => onPickMedia('audio'), undefined, !canUpload || uploading)}<button className="writing-embed-button" type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={onEmbed}>Embed video</button></div>
    <div className="writing-toolbar-group writing-toolbar-secondary"><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}>Table</button><button type="button" aria-label="Insert footnote" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={onFootnote}>Footnote</button></div>
    <div className="writing-toolbar-group">{icon('Undo', ArrowCounterClockwise, () => apply(chain => chain.undo()), undefined, !state?.undo)}{icon('Redo', ArrowClockwise, () => apply(chain => chain.redo()), undefined, !state?.redo)}</div>
    {state?.table && <div className="writing-toolbar-group writing-table-actions"><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.addRowAfter())}>Add row</button><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.addColumnAfter())}>Add column</button><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.mergeOrSplit())}>Merge / split</button><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.deleteRow())}>Remove row</button><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.deleteColumn())}>Remove column</button><button type="button" disabled={off} onMouseDown={(event) => event.preventDefault()} onClick={() => apply((chain) => chain.deleteTable())}>Remove table</button></div>}
    </div>
  </div>
}
