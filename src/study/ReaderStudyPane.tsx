import { useEffect, useRef, useState } from 'react'
import { StudyDesk, type StudyNative } from './StudyDesk'
import { Dictionary, type DictionarySelection } from './Dictionary'

/** The extension passes the selected text or form through a private port. Study
 * records and edits stay inside the local workspace origin. */
export function ReaderStudyPane({ parentOrigin, mode }: { parentOrigin: string; mode: 'word' | 'application' }) {
  const [selection, setSelection] = useState<DictionarySelection | null>(null)
  const [connected, connect] = useState(false)
  const port = useRef<MessagePort | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const waiting = useRef<((value?: Awaited<ReturnType<StudyNative['form']>>, error?: string) => void) | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== parentOrigin || (event.source && event.source !== window.parent) || event.data?.type !== 'enki:connect' || !event.ports[0] || port.current) return
      const channel = event.ports[0]
      port.current = channel
      if (mode === 'word' && typeof event.data.term === 'string' && event.data.term.trim()) {
        setSelection({ serial: 1, text: event.data.term.slice(0,160), context: {url: event.data.url, sourceApp:'Worldview Reader'} })
      }
      channel.onmessage = ({ data }) => {
        if (data?.type === 'form') waiting.current?.(data.form, data.error)
        if (data?.type === 'focus') content.current?.querySelector<HTMLElement>('input,button')?.focus({preventScroll:true})
      }
      channel.postMessage({type:'ready'})
      connect(true)
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({type:'enki:study-ready', mode}, parentOrigin)
    return () => {
      window.removeEventListener('message', receive)
      waiting.current?.(undefined, 'The Reader panel was closed.')
      port.current?.close()
      port.current = null
    }
  }, [parentOrigin, mode])

  useEffect(() => {
    const pane = content.current
    if (!pane || !connected) return
    const observer = new ResizeObserver(() => port.current?.postMessage({type:'height', height: Math.ceil(pane.getBoundingClientRect().height)}))
    observer.observe(pane)
    return () => observer.disconnect()
  }, [connected])

  const form: StudyNative['form'] = () => new Promise((resolve, reject) => {
    if (!port.current || waiting.current) { reject(Error('Open the application tab and try again.')); return }
    const timer = setTimeout(() => waiting.current?.(undefined, 'The browser did not return a form. Try reading the page again.'), 12000)
    waiting.current = (value, error) => {
      clearTimeout(timer)
      waiting.current = null
      if (value && !error) resolve(value)
      else reject(Error(error || 'Open a form in the active tab.'))
    }
    port.current.postMessage({type:'read-form'})
  })
  return <div className="enki-reader-scroll"><div className="helper-pane" ref={content}>
    {!connected ? <p role="status">Opening tool…</p> : mode === 'word' ? <Dictionary selection={selection} /> :
      <><h1>Applications</h1><StudyDesk mode="application" native={{ form, activeTab: true }} helper /></>}
  </div></div>
}
