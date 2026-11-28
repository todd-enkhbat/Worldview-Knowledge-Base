import { useState, type ReactNode } from 'react'
import { Trash } from '@phosphor-icons/react'
import { softDelete, useRepoStatus } from '../data/repo.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { archiveWritingDocument } from '../writing/store.ts'
import { archiveBook } from '../bookshelf/store.ts'
import type { ShelfKind } from '../bookshelf/types.ts'
import { deleteFolder } from './store.ts'
import { ReadingDialog } from './ReadingDialog.tsx'

export function DeleteLibraryItem({ id, name, kind, shelfKind, folderDestination, retainsSource, onDeleted, children }: {
  id: string
  name: string
  kind: 'folder' | 'book' | 'writing' | 'source' | 'record'
  shelfKind?: ShelfKind
  folderDestination?: string
  retainsSource?: boolean
  onDeleted?: (archive: { name: string; href: string } | null) => void
  children?: (confirm: () => void, disabled: boolean) => ReactNode
}) {
  const writer = useRepoStatus(state => state.writer)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const archive = kind === 'book' ? { name: 'Bookshelf Trash', href: `#/bookshelf?view=trash&kind=${shelfKind ?? 'book'}` }
    : kind === 'writing' ? { name: 'Writing Trash', href: '#/write?view=trash' } : null
  function confirm() { setError(''); setConfirming(true) }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (kind === 'folder') await deleteFolder(id)
      else if (kind === 'book') await archiveBook(id)
      else if (kind === 'writing') await archiveWritingDocument(id)
      else if (kind === 'record') await softDelete(id)
      else {
        const source = useKnowledge.getState().sources.find(source => source.id === id)
        if (!source?.nodeId) throw new Error('This file is still being prepared. Wait for the import to finish, then try again.')
        await softDelete(source.nodeId)
      }
      setConfirming(false); onDeleted?.(archive)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <>
    {children ? children(confirm, !writer) : <button type="button" className="knowledge-icon-button library-delete" aria-label={`Delete ${name}`} title={`Delete ${name}`} disabled={!writer} onClick={confirm}><Trash size={15} /></button>}
    {confirming && <ReadingDialog title={kind === 'folder' ? 'Delete this section?' : 'Move this file to Trash?'} onClose={() => { if (!busy) setConfirming(false) }}>
      {kind === 'folder' ? <p className="library-delete-description"><strong>{name}</strong> will be deleted permanently. Its files and nested sections will move to {folderDestination || 'My library'}.</p>
        : <p className="library-delete-description"><strong>{name}</strong> will move to {archive ? <a href={archive.href}>{archive.name}</a> : 'the Trash in the main navigation'}. You can restore it there.</p>}
      {retainsSource && <p>The retained source stays in Library.</p>}
      {error && <p role="alert" className="knowledge-error">{error}</p>}
      <footer className="library-delete-actions"><button data-dialog-initial-focus type="button" className="knowledge-button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="knowledge-button library-confirm-delete" disabled={busy || !writer} onClick={() => void remove()}>{busy ? 'Deleting…' : kind === 'folder' ? 'Delete section, keep contents' : 'Move to Trash'}</button></footer>
    </ReadingDialog>}
  </>
}
