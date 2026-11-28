import { DeleteLibraryItem } from './DeleteLibraryItem.tsx'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { CaretDown, CaretRight, FileText, MagnifyingGlass, Books, NotePencil } from '@phosphor-icons/react'
import { useBookshelf } from '../bookshelf/store.ts'
import { bookHref } from '../bookshelf/model.ts'
import { usePersonalLibrary } from './personalLibrary.ts'
import { useReading } from './store.ts'
import { FolderIcon } from './FolderPage.tsx'
import { folderHref, folderTrail } from './hierarchy.ts'

interface TreeFile { sourceId?: string; id: string; name: string; folderId: string | null; href: string; kind: 'book' | 'note' | 'source' }
export function FolderExplorer({ hash, onNavigate }: { hash: string; onNavigate: () => void }) {
  const reading = useReading(), books = useBookshelf(state => state.books)
  const { sources, writings, nodes } = usePersonalLibrary()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set()), [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()), [query, setQuery] = useState('')
  const params = new URLSearchParams(hash.split('?')[1] ?? '')
  const files = useMemo(() => {
    const items = new Map(reading.items.map(item => [item.sourceId, item])), represented = new Set<string>(), entries: TreeFile[] = []
    const activeBooks = books.filter(book => !book.archivedAt && items.get('book:' + book.id)?.libraryVisible !== false)
    for (const book of activeBooks) { if (book.sourceId) represented.add(book.sourceId); entries.push({ sourceId: book.sourceId, id: 'book:' + book.id, name: book.title, kind: 'book', folderId: items.get('book:' + book.id)?.folderId ?? (book.sourceId ? items.get(book.sourceId)?.folderId : null) ?? null, href: bookHref(book.id) }) }
    for (const writing of writings) {
      const linkedSource = writing.basedOnSourceId ?? writing.sourceId
      if (linkedSource && represented.has(linkedSource)) continue
      if (linkedSource) represented.add(linkedSource)
      entries.push({ sourceId: linkedSource, id: 'writing:' + writing.id, name: writing.title || 'Untitled writing', kind: 'note', folderId: items.get('writing:' + writing.id)?.folderId ?? (linkedSource ? items.get(linkedSource)?.folderId : null) ?? null, href: writing.basedOnSourceId ? `#/library?source=${encodeURIComponent(writing.basedOnSourceId)}` : `#/write?doc=${encodeURIComponent(writing.id)}` })
    }
    for (const source of sources) if (!represented.has(source.id)) {
      if (source.nodeId) represented.add(source.nodeId)
      const folderId = items.get(source.id)?.folderId ?? null
      entries.push({ id: source.id, name: source.title, kind: 'source', folderId, href: `#/library?source=${encodeURIComponent(source.id)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}` })
    }
    for (const node of nodes.values()) if (!represented.has(node.id) && !sources.some(source => source.nodeId === node.id)) entries.push({ id: node.id, name: node.title, kind: 'source', folderId: items.get(node.id)?.folderId ?? null, href: `#/library?record=${encodeURIComponent(node.id)}` })
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }, [reading.items, sources, writings, nodes, books])
  const selectedFile = files.find(file => file.href === hash || params.get('source') === (file.sourceId ?? file.id) || `writing:${params.get('doc')}` === file.id || `book:${params.get('book')}` === file.id)
  const selectedFolder = params.get('folder') ?? selectedFile?.folderId ?? null
  const ancestors = new Set(folderTrail(reading.folders, selectedFolder).map(folder => folder.id))
  const activeFolders = reading.folders.filter(folder => !folder.deletedAt)
  const search = query.trim().toLocaleLowerCase()
  const matchingFiles = files.filter(file => !search || file.name.toLocaleLowerCase().includes(search))
  const matches = new Set<string>()
  if (search) {
    for (const folder of activeFolders) if (folder.name.toLocaleLowerCase().includes(search)) for (const entry of folderTrail(activeFolders, folder.id)) matches.add(entry.id)
    for (const file of matchingFiles) for (const entry of folderTrail(activeFolders, file.folderId)) matches.add(entry.id)
  }
  const folderChildren = new Map<string | null, typeof activeFolders>(), fileChildren = new Map<string | null, TreeFile[]>()
  for (const folder of activeFolders) folderChildren.set(folder.parentId, [...(folderChildren.get(folder.parentId) ?? []), folder])
  for (const file of matchingFiles) fileChildren.set(file.folderId, [...(fileChildren.get(file.folderId) ?? []), file])
  const rows: { id: string; depth: number; folder?: typeof activeFolders[number]; file?: TreeFile; open?: boolean; unfiled?: boolean }[] = []
  const stack: ({ folder: typeof activeFolders[number]; depth: number } | { file: TreeFile; depth: number })[] = [...(folderChildren.get(null) ?? [])].sort((a,b) => b.name.localeCompare(a.name)).map(folder => ({ folder, depth: 1 }))
  while (stack.length) {
    const task = stack.pop()!
    if ('file' in task) { rows.push({ id: task.file.id, depth: task.depth, file: task.file }); continue }
    const { folder, depth } = task
    if (search && !matches.has(folder.id)) continue
    const open = !!search || expanded.has(folder.id) || !collapsed.has(folder.id) && (ancestors.has(folder.id) || depth === 1)
    rows.push({ id: folder.id, depth, folder, open })
    if (open) {
      const children = [...(folderChildren.get(folder.id) ?? [])].sort((a,b) => a.name.localeCompare(b.name))
      // Reverse the tasks so child pages appear before loose files at each level.
      for (const file of [...(fileChildren.get(folder.id) ?? [])].reverse()) stack.push({ file, depth: depth + 1 })
      for (const child of children.reverse()) stack.push({ folder: child, depth: depth + 1 })
    }
  }
  const unfiled = fileChildren.get(null) ?? []
  if (unfiled.length) { rows.push({ id: 'unfiled', depth: 1, unfiled: true, open: !!search || expanded.has('unfiled') }); if (search || expanded.has('unfiled')) for (const file of unfiled) rows.push({ id: file.id, depth: 2, file }) }
  const toggle = (id: string, open: boolean) => { setExpanded(previous => { const next = new Set(previous); if (open) next.delete(id); else next.add(id); return next }); setCollapsed(previous => { const next = new Set(previous); if (open) next.add(id); else next.delete(id); return next }) }
  const navigate = (href: string) => { location.hash = href; onNavigate() }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, row: typeof rows[number]) {
    const buttons = [...event.currentTarget.closest('[role="tree"]')!.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')], index = buttons.indexOf(event.currentTarget)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus() }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus() }
    if (event.key === 'ArrowRight' && (row.folder || row.unfiled)) { event.preventDefault(); if (!row.open) toggle(row.id, false); else buttons[index + 1]?.focus() }
    if (event.key === 'ArrowLeft') { event.preventDefault(); if ((row.folder || row.unfiled) && row.open) toggle(row.id, true); else { const parent = row.folder?.parentId ?? row.file?.folderId ?? 'unfiled'; buttons.find(button => button.dataset.folder === parent)?.focus() } }
  }
  return <section className="hierarchy-explorer" aria-label="File explorer"><header><h2>Your files</h2></header>
    <label className="hierarchy-explorer-search"><MagnifyingGlass size={14} /><span className="knowledge-sr-only">Find a folder or file</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a folder or file…" /></label>
    <button className="hierarchy-all-files" onClick={() => navigate('#/library')}><Books size={16} />All files</button>
    {!reading.loaded ? <p role="status">Opening folders…</p> : <div role="tree" aria-label="Folders and files">{rows.map(row => {
      if (row.unfiled) return <div role="none" className="hierarchy-tree-row" key={row.id}><span className="hierarchy-tree-spacer" /><button type="button" role="treeitem" aria-level={1} aria-expanded={row.open} data-folder="unfiled" onKeyDown={event => keyboard(event, row)} onClick={() => toggle('unfiled', !!row.open)}>{row.open ? <CaretDown size={12} /> : <CaretRight size={12} />}<span>Unfiled · {unfiled.length}</span></button></div>
      const selected = row.folder ? !params.get('source') && !params.get('doc') && selectedFolder === row.id : selectedFile?.id === row.id
      const Icon = row.file?.kind === 'book' ? Books : row.file?.kind === 'note' ? NotePencil : FileText
      return <div role="none" key={row.id} className="hierarchy-tree-row" style={{ paddingLeft: Math.min(row.depth - 1, 10) * 12 }}>
        {row.folder ? <button className="hierarchy-tree-expand" type="button" tabIndex={-1} aria-label={`${row.open ? 'Collapse' : 'Expand'} ${row.folder.name}`} onClick={() => toggle(row.id, !!row.open)}>{row.open ? <CaretDown size={12} /> : <CaretRight size={12} />}</button> : <span className="hierarchy-tree-spacer" />}
        <button role="treeitem" aria-level={row.depth} aria-selected={selected} aria-expanded={row.folder ? row.open : undefined} data-folder={row.folder?.id} title={row.folder ? folderTrail(activeFolders, row.id).map(folder => folder.name).join(' / ') : row.file!.name} onKeyDown={event => keyboard(event, row)} onClick={() => navigate(row.folder ? folderHref(row.id) : row.file!.href)}>{row.folder ? <FolderIcon folder={row.folder} size={16} /> : <Icon size={15} />}<span>{row.folder?.name ?? row.file!.name}</span></button>
        <DeleteLibraryItem id={row.file?.kind === "book" || row.file?.kind === "note" ? row.id.slice(row.id.indexOf(":") + 1) : row.id} name={row.folder?.name ?? row.file!.name} kind={row.folder ? "folder" : row.file!.kind === "book" ? "book" : row.file!.kind === "note" ? "writing" : sources.some(source => source.id === row.id) ? "source" : "record"} shelfKind={row.file?.kind === "book" ? books.find(book => "book:" + book.id === row.id)?.kind : undefined} folderDestination={activeFolders.find(folder => folder.id === row.folder?.parentId)?.name} retainsSource={!!row.file?.sourceId} onDeleted={() => { if (selected) navigate(folderHref(row.folder?.parentId ?? row.file?.folderId ?? null)) }} />
      </div>
    })}{!rows.length && <p>{search ? 'No matching folders or files.' : 'Create a page to start organizing.'}</p>}</div>}
    {reading.error && <p role="alert" className="knowledge-error">{reading.error}</p>}
  </section>
}
