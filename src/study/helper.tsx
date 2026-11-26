import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Lookup, StudyDesk, type StudyNative } from './StudyDesk'
import type {WordContext} from './model'
import './helper.css'

type Mode = 'word' | 'person' | 'application'
interface Bridge extends StudyNative {
  mode: (mode: Mode) => Promise<void>
  close: () => Promise<void>
  selection: () => Promise<{text:string;context:WordContext}>
  shortcut: (accelerator?: string) => Promise<string>
}
const bridge = (window as unknown as { profileCapture?: Bridge }).profileCapture

function Helper() {
  const word = new URLSearchParams(location.search).get('mode') !== 'application'
  const [selection, setSelection] = useState<string | null>(null)
  const [context,setContext]=useState<WordContext>({})
  const [shortcut, setShortcut] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    void bridge
      ?.selection()
      .then(value=>{setContext(value.context);setSelection(value.text)})
      .catch(() => setSelection(''))
    void bridge
      ?.shortcut()
      .then(setShortcut)
      .catch((e) => setStatus(e.message))
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void bridge?.close()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  return (
    <>
      <header className="helper-bar">
        <span aria-label="Drag window">⠿</span>
        <nav className="capture-modes" aria-label="Capture mode">
        {(['word', 'person', 'application'] as const).map((mode) => (
          <button
            key={mode === 'word' ? 'Dictionary' : mode === 'person' ? 'Person' : 'Application'}
            aria-pressed={mode === (word ? 'word' : 'application')}
            onClick={() => void bridge?.mode(mode)}
          >
            {mode === 'word' ? 'Dictionary' : mode === 'person' ? 'Person' : 'Application'}
          </button>
        ))}
        </nav>
        <button aria-label="Hide helper" onClick={() => void bridge?.close()}>
          ×
        </button>
      </header>
      <div className="helper-body">
        {word ? (
          (selection !== null || !bridge) && <Lookup context={context} initial={selection ?? ''} />
        ) : (
          <StudyDesk mode="application" initialQuery={selection ?? ''} native={bridge} />
        )}
        {bridge && (
          <details>
            <summary>Keyboard shortcut</summary>
            <form
              onSubmit={async (event) => {
                event.preventDefault()
                try {
                  setShortcut(await bridge.shortcut(shortcut))
                  setStatus('Shortcut saved')
                } catch (e) {
                  setStatus((e as Error).message)
                }
              }}
            >
              <input aria-label="Global shortcut" value={shortcut} onChange={(e) => setShortcut(e.target.value)} />
              <button>Save shortcut</button>
            </form>
            <p role="status">{status}</p>
          </details>
        )}
      </div>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Helper />)
