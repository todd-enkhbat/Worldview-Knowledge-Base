import { useState } from 'react'
import { Book, Books, Brain, CalendarBlank, CaretRight, Code, Compass, FolderSimple, GearSix, GlobeHemisphereWest, GraduationCap, Heart, Image, Leaf, Lightbulb, NotePencil, Palette, Plus, Star, Users } from '@phosphor-icons/react'
import { Markdown } from '../hud/markdown.ts'
import { useWritingAssetUrl } from '../writing/WritingMediaView.tsx'
import { uploadWritingBackground } from '../writing/media.ts'
import { getStore, getWorldGeneration, useRepoStatus } from '../data/repo.ts'
import { createFolder, deleteFolder, updateFolder, useReading } from './store.ts'
import { ReadingDialog } from './ReadingDialog.tsx'
import { canMoveFolder, FOLDER_ICONS, FOLDER_KINDS, folderHref, folderTrail, suggestedFolderIcon } from './hierarchy.ts'
import type { ReadingFolder } from './types.ts'
import './hierarchy.css'

const icons = { folder: FolderSimple, books: Books, book: Book, graduation: GraduationCap, brain: Brain, lightbulb: Lightbulb, palette: Palette, heart: Heart, globe: GlobeHemisphereWest, users: Users, code: Code, calendar: CalendarBlank, star: Star, note: NotePencil, leaf: Leaf, compass: Compass }
export const COVER_PRESETS = { earth: '/brand/earth.jpg', library: '/covers/library.webp', forest: '/covers/forest.webp', architecture: '/covers/architecture.webp', sky: '/galaxy/milky-way.png', none: '' }
export function defaultCover(folder: ReadingFolder): keyof typeof COVER_PRESETS {
  return /books|reading|academ/i.test(folder.name) ? 'library' : /philosoph|civiliz|humanit|art/i.test(folder.name) ? 'architecture' : /life|living|relationship|love/i.test(folder.name) ? 'forest' : /time|eternity|space|t-rex/i.test(folder.name) ? 'sky' : 'earth'
}
export function FolderIcon({ folder, size = 18 }: { folder: ReadingFolder; size?: number }) {
  const { url } = useWritingAssetUrl(folder.iconAssetId ?? null)
  const Icon = icons[(folder.icon ?? suggestedFolderIcon(folder.name)) as keyof typeof icons] ?? FolderSimple
  return url ? <img className="hierarchy-icon-photo" src={url} alt="" width={size} height={size} /> : <Icon size={size} aria-hidden="true" />
}
export function FolderEditor({ folder, parentId = null, onClose, onSaved }: { folder?: ReadingFolder; parentId?: string | null; onClose: () => void; onSaved?: (folder: ReadingFolder) => void }) {
  const folders = useReading(state => state.folders), writer = useRepoStatus(state => state.writer)
  const [name, setName] = useState(folder?.name ?? ''), [parent, setParent] = useState(folder?.parentId ?? parentId ?? '')
  const [kind, setKind] = useState(folder?.kind ?? 'folder'), [typeLabel, setTypeLabel] = useState(folder?.typeLabel ?? '')
  const [description, setDescription] = useState(folder?.description ?? ''), [icon, setIcon] = useState(folder?.icon ?? suggestedFolderIcon(folder?.name ?? ''))
  const [iconAssetId, setIconAsset] = useState(folder?.iconAssetId ?? null), [coverAssetId, setCoverAsset] = useState(folder?.coverAssetId ?? null)
  const [coverPreset, setPreset] = useState<keyof typeof COVER_PRESETS>(folder?.coverPreset ?? defaultCover(folder ?? { name } as ReadingFolder)), [position, setPosition] = useState(folder?.coverPosition ?? 50)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [coverChosen, setCoverChosen] = useState(!!folder), [removing, setRemoving] = useState(false)
  const [scope] = useState(() => ({ store: getStore(), generation: getWorldGeneration() }))
  const cover = useWritingAssetUrl(coverAssetId)
  async function upload(file: File | undefined, target: 'icon' | 'cover') {
    if (!file) return
    setBusy(true); setError('')
    try { const id = await uploadWritingBackground(file, scope); if (target === 'icon') setIconAsset(id); else setCoverAsset(id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return <ReadingDialog title={folder ? 'Customize page' : 'Create a page'} onClose={() => { if (!busy) onClose() }}><form className="hierarchy-editor" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('')
    const details = { kind, typeLabel, description, icon, iconAssetId, coverAssetId, coverPreset, coverPosition: position }
    if (!folder && folders.some(entry => !entry.deletedAt && entry.parentId === (parent || null) && entry.name.normalize('NFKC').trim().toLocaleLowerCase().replace(/[-_\s]+/g, ' ') === name.normalize('NFKC').trim().toLocaleLowerCase().replace(/[-_\s]+/g, ' '))) { setError('A page with this name already exists here. Choose another name or parent.'); setBusy(false); return }
    const task = folder ? updateFolder(folder.id, { ...details, name, parentId: parent || null }) : createFolder(name, parent || null, details)
    void task.then(result => { onSaved?.(result); onClose() }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
  }}>
    <label>Name<input required maxLength={160} value={name} onChange={event => { setName(event.target.value); if (!folder && icon === 'folder') setIcon(suggestedFolderIcon(event.target.value)); if (!coverChosen) setPreset(defaultCover({ name: event.target.value } as ReadingFolder)) }} placeholder="A subject, a project, an idea…" /></label>
    <div className="hierarchy-form-pair"><label>Page type<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{FOLDER_KINDS.map(kind => <option key={kind} value={kind}>{kind[0].toUpperCase() + kind.slice(1)}</option>)}</select></label><label>Custom type label<input value={typeLabel} maxLength={80} onChange={event => setTypeLabel(event.target.value)} placeholder="Chapter, collection, question…" /></label></div>
    <label>Inside<select value={parent} onChange={event => setParent(event.target.value)}><option value="">Library · top level</option>{folders.filter(entry => !entry.deletedAt && (!folder || canMoveFolder(folders, folder.id, entry.id))).map(entry => <option key={entry.id} value={entry.id}>{folderTrail(folders, entry.id).map(item => item.name).join(' / ')}</option>)}</select></label>
    <label>Page text<textarea rows={5} maxLength={20000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Write an introduction, a note, or a question. Markdown is supported." /></label>
    <fieldset className="hierarchy-icon-picker"><legend>Icon</legend><div>{FOLDER_ICONS.map(value => { const Icon = icons[value]; return <button type="button" key={value} aria-label={`${value} icon`} aria-pressed={icon === value && !iconAssetId} onClick={() => { setIcon(value); setIconAsset(null) }}><Icon size={22} /></button> })}</div><label>Or upload an icon picture<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" disabled={busy} onChange={event => { void upload(event.target.files?.[0], 'icon'); event.target.value = '' }} /></label></fieldset>
    <fieldset className="hierarchy-cover-picker"><legend>Cover</legend><div>{Object.entries(COVER_PRESETS).map(([value, url]) => <button type="button" key={value} aria-label={`${value} cover`} aria-pressed={coverPreset === value && !coverAssetId} onClick={() => { setPreset(value as keyof typeof COVER_PRESETS); setCoverAsset(null); setCoverChosen(true) }}>{url ? <img src={url} alt="" loading="lazy" width={160} height={54} /> : <Image size={20} />}<span>{value === 'none' ? 'No cover' : value}</span></button>)}</div><label>Upload your own cover<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" disabled={busy} onChange={event => { void upload(event.target.files?.[0], 'cover'); event.target.value = '' }} /></label>{(cover.url || COVER_PRESETS[coverPreset]) && <><img width={1600} height={240} className="hierarchy-cover-preview" src={cover.url || COVER_PRESETS[coverPreset]} alt="Cover position preview" style={{ objectPosition: `center ${position}%` }} /><label>Cover position · {position}%<input type="range" min="0" max="100" value={position} onChange={event => setPosition(Number(event.target.value))} /></label></>}</fieldset>
    <p className="hierarchy-form-note">Every page can contain more pages and files, whatever its type. Your original files stay intact.</p>
    {removing && <p role="status">Remove this page? Its files and nested pages will move to the parent. Original notes stay saved.</p>}
    {error && <p role="alert" className="knowledge-error">{error}</p>}
    <footer>{folder && <button type="button" className="knowledge-button" disabled={!writer || busy} onClick={() => {
      if (!removing) { setRemoving(true); return }
      setBusy(true); setError(''); void deleteFolder(folder.id).then(() => { location.hash = folderHref(folder.parentId); onClose() }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
    }}>{removing ? 'Confirm removal; keep contents' : 'Remove page, keep contents'}</button>}<button type="button" className="knowledge-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="knowledge-button is-primary" disabled={!writer || busy || !name.trim()}>{busy ? 'Saving…' : folder ? 'Save changes' : 'Create page'}</button></footer>
  </form></ReadingDialog>
}
export function FolderPageHeader({ folder }: { folder: ReadingFolder }) {
  const folders = useReading(state => state.folders), writer = useRepoStatus(state => state.writer)
  const [editing, setEditing] = useState(false), [adding, setAdding] = useState(false)
  const cover = useWritingAssetUrl(folder.coverAssetId ?? null)
  const image = cover.url || COVER_PRESETS[folder.coverPreset ?? defaultCover(folder)]
  return <section className="hierarchy-page-header" aria-label={`${folder.name} page`}>
    <nav className="hierarchy-breadcrumbs" aria-label="Folder breadcrumbs"><a href="#/library">Library</a>{folderTrail(folders, folder.id).map(entry => <span key={entry.id}><CaretRight size={12} /><a href={folderHref(entry.id)} aria-current={entry.id === folder.id ? 'page' : undefined}>{entry.name}</a></span>)}</nav>
    {image && <div className="hierarchy-cover"><img width={1600} height={240} src={image} alt="" style={{ objectPosition: `center ${folder.coverPosition ?? 50}%` }} /><button type="button" className="knowledge-button" disabled={!writer} onClick={() => setEditing(true)}><Image size={15} />Change cover</button></div>}
    <div className="hierarchy-page-identity"><div className="hierarchy-page-symbol"><FolderIcon folder={folder} size={38} /></div><div><h2>{folder.name}</h2><p>{folder.typeLabel || folder.kind || 'Folder'} · {folders.filter(entry => !entry.deletedAt && entry.parentId === folder.id).length} nested pages</p></div><div className="hierarchy-page-actions"><button className="knowledge-button" disabled={!writer} onClick={() => setEditing(true)}><GearSix size={16} />Customize</button><button className="knowledge-button" disabled={!writer} onClick={() => setAdding(true)}><Plus size={16} />Add inside</button></div></div>
    {folder.linkedTopicId && <div className="hierarchy-concept-links"><a className="knowledge-button" href={`#/topics?topic=${encodeURIComponent(folder.linkedTopicId)}`}><Brain size={16} />Open linked concept</a><a className="knowledge-button" href={`#/graph?topic=${encodeURIComponent(folder.linkedTopicId)}`}>See connections</a><p>Notes filed here also connect to this topic.</p></div>}
    {folder.description && <Markdown source={folder.description} className="hierarchy-page-text" />}
    {cover.error && <p role="alert" className="knowledge-error">{cover.error} Choose another cover in Customize.</p>}
    {editing && <FolderEditor key={folder.id} folder={folder} onClose={() => setEditing(false)} />}
    {adding && <FolderEditor parentId={folder.id} onClose={() => setAdding(false)} onSaved={entry => { location.hash = folderHref(entry.id) }} />}
  </section>
}
