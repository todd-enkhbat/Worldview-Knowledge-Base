import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AddressBookTabs, BookOpenText, CheckSquare, FileText, Globe, Keyboard, X } from '@phosphor-icons/react'
import { EnkiPage, type PageBridge } from './EnkiPage'
import portrait from '../../electron/enki-model-front.webp'
import { StudyDesk, type StudyNative } from './StudyDesk'
import { EnkiTodos } from './EnkiTodos'
import { EnkiPerson, type ProfileBridge } from './EnkiPerson'
import { Dictionary } from './Dictionary'
import { ReaderStudyPane } from './ReaderStudyPane'
import type { WordContext } from './model'
import './helper.css'

const tools = [
  { id: 'page', label: 'Page', icon: Globe },
  { id: 'word', label: 'Dictionary', icon: BookOpenText },
  { id: 'person', label: 'CRM', icon: AddressBookTabs },
  { id: 'application', label: 'Application', icon: FileText },
  { id: 'todo', label: 'TO-DO', icon: CheckSquare },
] as const
type Mode = typeof tools[number]['id']
type Selection = { text: string; context: WordContext }
type Bridge = StudyNative & ProfileBridge & PageBridge & {
  mode: (mode: Mode) => Promise<void>
  close: () => Promise<void>
  selection: () => Promise<Selection>
  shortcut: (accelerator?: string) => Promise<string>
  onShowMode: (callback: (request: {mode: Mode; hasSelection?: boolean; refreshPage?: boolean}) => void) => () => void
  celebrate: () => void
}
const bridge = (window as unknown as { profileCapture?: Bridge }).profileCapture
const requested = new URLSearchParams(location.search).get('mode')
const initial = tools.find(tool => tool.id === requested)?.id || 'word'

function Shortcuts({ native }: { native: Bridge }) {
  const [shortcut, setShortcut] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  return <>
    <button className="enki-header-action" popoverTarget="enki-shortcuts" aria-label="Keyboard shortcuts" title="Keyboard shortcuts"><Keyboard size={18} aria-hidden="true" /></button>
    <div id="enki-shortcuts" popover="auto" onToggle={event => {
      if (event.newState === 'open') void native.shortcut().then(setShortcut).catch(e => setMessage(e.message))
    }}>
      <h2>Keyboard shortcuts</h2>
      <p>Open Enki <kbd>]]]</kbd> · Reads your current page in Dia.</p>
      <form onSubmit={async event => {
        event.preventDefault()
        if (saving) return
        setSaving(true)
        try { setShortcut(await native.shortcut(shortcut)); setMessage('Shortcut saved.') }
        catch (e) { setMessage(e instanceof Error ? e.message : 'Could not save the shortcut.') }
        finally { setSaving(false) }
      }}>
        <label className="enki-field">Capture selected text<input name="shortcut" value={shortcut} onChange={event => setShortcut(event.target.value)} /></label>
        <button disabled={saving}>Save</button>
      </form>
      <p role="status" className="enki-help-status">{message}</p>
    </div>
  </>
}

function Helper() {
  const [mode, setMode] = useState<Mode>(initial)
  const [visited, setVisited] = useState<Mode[]>([initial])
  const [word, setWord] = useState<(Selection & { serial: number }) | null>(null)
  const [applicationQuery, setApplicationQuery] = useState('')
  const [error, setError] = useState('')
  const [pageSerial, setPageSerial] = useState(0)
  const focusFrame = useRef(0)
  const selectionRequest = useRef(0)
  const scroll = useRef<Partial<Record<Mode, number>>>({})
  const scrollView = useRef<HTMLDivElement>(null)
  const currentMode = useRef(initial)
  const focus = useCallback((id: Mode, tab = false) => {
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      if (id === 'todo') window.dispatchEvent(new Event('worldview:todos-refresh'))
      const pane = document.getElementById('pane-' + id)
      const selectors = id === 'todo' ? ['.enki-delete-actions button', 'textarea[aria-label="Edit task"]', 'input[name="listName"]', 'textarea[name="task"]']
        : id === 'word' ? ['.study-lookup input'] : id === 'person' ? ['[data-primary]'] : ['input[name=opportunity]', '.study-tools button']
      const field = selectors.map(selector => pane?.querySelector<HTMLElement>(selector)).find(element => element?.getClientRects().length)
      if (tab || !field || field.matches(':disabled')) document.getElementById('tool-' + id)?.focus({ preventScroll: true })
      else field.focus({ preventScroll: true })
    })
  }, [])
  const activate = useCallback((id: Mode, tab = false) => {
    if (!tools.some(tool => tool.id === id)) return
    const previous = currentMode.current
    currentMode.current = id
    if (previous !== id) {
      if (scrollView.current) scroll.current[previous] = scrollView.current.scrollTop
      setVisited(values => values.includes(id) ? values : [...values, id])
      setError('')
      setMode(id)
      history.replaceState(null, '', '?mode=' + id)
    }
    focus(id, tab)
  }, [focus])
  const readSelection = useCallback(async (id: Mode) => {
    const request = ++selectionRequest.current
    if (!bridge || (id !== 'word' && id !== 'application')) return
    try {
      const selection = await bridge.selection()
      if (request !== selectionRequest.current || !selection.text) return
      if (id === 'word') setWord(value => ({ ...selection, serial: (value?.serial || 0) + 1 }))
      else setApplicationQuery(selection.text)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read selected text.') }
  }, [])
  useEffect(() => {
    if (scrollView.current) scrollView.current.scrollTop = scroll.current[mode] || 0
  }, [mode])
  useEffect(() => {
    void readSelection(initial)
    focus(initial)
    const stop = bridge?.onShowMode?.(({ mode: id, hasSelection, refreshPage }) => {
      activate(id)
      if (refreshPage) setPageSerial(value => value + 1)
      if (hasSelection) void readSelection(id)
    })
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector(':popover-open')) void bridge?.close()
    }
    window.addEventListener('keydown', escape)
    return () => { stop?.(); cancelAnimationFrame(focusFrame.current); window.removeEventListener('keydown', escape) }
  }, [readSelection, activate, focus])
  function choose(id: Mode, tab = false) {
    activate(id, tab)
    void bridge?.mode(id).catch(e => setError(e.message))
  }
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = { ArrowRight: (index + 1) % tools.length, ArrowLeft: (index + tools.length - 1) % tools.length, Home: 0, End: tools.length - 1 }[event.key]
    if (target === undefined) return
    event.preventDefault()
    choose(tools[target].id, true)
  }
  return (
    <div className="enki-shell">
      <header className="enki-header">
        <div className="enki-brand"><img src={portrait} alt="" width={34} height={34} /><span>Enki</span></div>
        <div className="enki-window-tools">
          {bridge && <Shortcuts native={bridge} />}
          {bridge && <button aria-label="Hide helper" className="enki-header-action" title="Hide Enki panel (Esc)" onClick={() => void bridge.close()}><X aria-hidden="true" size={17} /></button>}
        </div>
      </header>
      <nav className="enki-nav" aria-label="Enki tools" role="tablist">
        {tools.map(({ id, label, icon: Icon }, index) => (
          <button key={id} id={'tool-' + id} type="button" role="tab" tabIndex={id === mode ? 0 : -1}
            aria-selected={id === mode} aria-controls={'pane-' + id} onClick={() => choose(id)} onKeyDown={event => navigateTabs(event, index)}>
            <Icon size={16} aria-hidden="true" />{label}
          </button>
        ))}
      </nav>
      <div className="enki-panes" ref={scrollView}>
        {error && <p role="alert" className="enki-help-error">{error}</p>}
        {tools.map(({ id }) => <div key={id} className="helper-pane" id={'pane-' + id} role="tabpanel" aria-labelledby={'tool-' + id} data-mode={id} hidden={mode !== id}>
          {visited.includes(id) && <>
            {id === 'page' && <EnkiPage key={pageSerial} bridge={bridge} />}
            {id === 'todo' && <EnkiTodos onCelebrate={bridge?.celebrate} />}
            {id === 'word' && <Dictionary selection={word} />}
            {id === 'person' && <EnkiPerson key={pageSerial} bridge={bridge} autoRead={mode === id} browserConnected />}
            {id === 'application' && <><h1>Applications</h1><StudyDesk mode="application" initialQuery={applicationQuery} native={bridge} helper /></>}
          </>}
        </div>)}
      </div>
    </div>
  )
}
const readerId = new URLSearchParams(location.search).get('reader') || ''
const isReader = window.parent !== window && /^[a-p]{32}$/.test(readerId) && (initial === 'word' || initial === 'application')
createRoot(document.getElementById('root')!).render(isReader
  ? <ReaderStudyPane parentOrigin={'chrome-extension://' + readerId} mode={initial} />
  : <Helper />)
