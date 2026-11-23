import { useRef, useState, type ChangeEvent } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { stage, useChat } from '../ai/chat/session.ts'
import { intake, intakeFolderFiles } from './chatIntake.ts'
import { ProductDialog } from './ProductDialog.tsx'
import './Sources.css'

const SOURCES = [
  { name: 'Google Drive', mark: 'G', detail: 'Documents, slides, sheets, and files', how: 'Download the files you want from Drive and add them here. Export Google Docs as .docx, .pdf, or plain text. You can also save a Drive link as a reference.' },
  { name: 'Obsidian', mark: 'O', detail: 'Notes, tags, wikilinks, and attachments', how: 'Choose your vault folder. Markdown notes become memories in your world, wikilinks become connections, and referenced attachments travel with their notes. Dates come from frontmatter or file dates.' },
  { name: 'Granola', mark: 'G', detail: 'Meeting notes and transcripts', how: 'Export or copy a meeting’s notes into a text or Markdown file, then add it here. You can also paste your notes into the chat.' },
  { name: 'Wispr Flow', mark: 'W', detail: 'Your spoken thoughts', how: 'Use Wispr Flow to dictate directly into the Worldview chat or daily reflection. Saved transcripts can also be added as text files.' },
  { name: 'Figma', mark: 'F', detail: 'Designs, screenshots, and references', how: 'Export a frame as PNG or JPG and add it here to make it visible in your world. Save a Figma link alongside it to return to the original design.' },
  { name: 'Chrome', mark: 'C', detail: 'Bookmarks and the web', how: 'Paste a page link below, or export bookmarks as an HTML file and add it to the chat. Links remain references; private pages and browsing history are not automatically synced.' },
] as const

export function Sources({ onClose }: { onClose: () => void }) {
  const writer = useRepoStatus((s) => s.writer)
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const source = SOURCES[selected]

  async function addFiles(event: ChangeEvent<HTMLInputElement>, isFolder: boolean) {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!picked.length) return
    setBusy(true)
    setStatus(null)
    setError(null)
    const before = useWorld.getState().nodes.size
    const stagedBefore = useChat.getState().staged.length
    try {
      if (isFolder) await intakeFolderFiles(picked)
      else await intake(picked)
      const added = useWorld.getState().nodes.size - before
      const staged = useChat.getState().staged.length - stagedBefore
      const intakeError = useChat.getState().error
      if (intakeError) setError(intakeError)
      if (added) setStatus(`${added} ${added === 1 ? 'note imported' : 'notes imported'} into your world. Review the dates and connections in your library.`)
      else if (staged) setStatus(`${staged} ${staged === 1 ? 'item is' : 'items are'} ready in chat. Review and save ${staged === 1 ? 'it' : 'them'} to add to your world.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  function addLink() {
    setError(null)
    let link: URL
    try {
      link = new URL(url.trim())
      if (!['https:', 'http:'].includes(link.protocol)) throw new Error()
    } catch {
      setError('Enter a complete link beginning with https:// or http://.')
      return
    }
    stage([{
      name: link.hostname + (link.pathname === '/' ? '' : link.pathname),
      kind: 'page', bytes: 0, url: link.href,
      blocks: [{ type: 'text', text: `Source reference: ${link.href}\nThis link was added as a reference. The page contents have not been read.` }],
    }])
    useApp.getState().togglePanel('chat', true)
    setStatus('Your link is ready in chat. Save it as a reference, or add your own notes about it.')
    setUrl('')
  }

  function openChat() {
    useApp.getState().togglePanel('chat', true)
    onClose()
  }

  return (
    <ProductDialog title="Bring your world together" description="Your thoughts, files, and references, in one place." onClose={onClose}>
      <div className="sources-import">
        <div><h3>Start with what you already have</h3><p>Images, videos, audio, PDFs, documents, and folders. Originals stay attached to the notes you save.</p></div>
        <div className="sources-actions">
          <button className="product-button primary" type="button" disabled={!writer || busy} onClick={() => files.current?.click()}>{busy ? 'Adding…' : 'Add files'}</button>
          <button className="product-button" type="button" disabled={!writer || busy} onClick={() => folder.current?.click()}>Import a folder</button>
        </div>
        <input ref={files} type="file" multiple hidden aria-label="Choose source files" onChange={(e) => void addFiles(e, false)} />
        <input ref={folder} type="file" multiple hidden {...{ webkitdirectory: '' }} aria-label="Choose a source folder" onChange={(e) => void addFiles(e, true)} />
      </div>

      <div className="sources-services" aria-label="Source guides">
        {SOURCES.map((item, index) => <button key={item.name} type="button" aria-pressed={index === selected} className={`sources-service ${index === selected ? 'is-active' : ''}`} onClick={() => setSelected(index)}>
          <span className="sources-service-mark" aria-hidden="true">{item.mark}</span><span><strong>{item.name}</strong><small>{item.detail}</small></span>
        </button>)}
      </div>

      <section className="sources-guide" aria-labelledby="source-guide-title">
        <div className="sources-guide-heading"><h3 id="source-guide-title">Bring in {source.name}</h3><span>{source.name === 'Obsidian' ? 'Folder import' : source.name === 'Wispr Flow' ? 'Dictation & files' : 'Files & links'}</span></div>
        <p>{source.how}</p>
        {source.name === 'Obsidian' && <button className="product-button" disabled={!writer || busy} type="button" onClick={() => folder.current?.click()}>Choose vault folder</button>}
        <p className="sources-connection-note">{source.name === 'Obsidian' ? 'Import creates a local copy. Changes in your vault are not continuously synced.' : 'Automatic account sync is not configured. You choose what to bring in.'}</p>
      </section>

      <form className="sources-link" onSubmit={(e) => { e.preventDefault(); addLink() }}>
        <label htmlFor="sources-link-input">Save a link</label>
        <div><input id="sources-link-input" className="product-input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" required disabled={!writer || busy} /><button className="product-button" type="submit" disabled={!writer || busy || !url.trim()}>Add to chat</button></div>
        <small>Links are saved as references. Add an export or screenshot to include the content.</small>
      </form>
      {!writer && <p className="product-error" role="alert">This world is read-only in this tab. Open the writing tab to add sources.</p>}
      {error && <p className="product-error" role="alert">{error}</p>}
      {status && <div className="product-status" role="status"><p>{status}</p><button className="product-button primary" type="button" onClick={openChat}>Continue in chat</button></div>}
    </ProductDialog>
  )
}
