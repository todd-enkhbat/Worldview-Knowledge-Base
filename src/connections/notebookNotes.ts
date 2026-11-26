import { getStore, getWorldGeneration, isRepoReady, retainWorldBlob } from '../data/repo.ts'
import { ingestRetainedSource, knowledgeHash } from '../knowledge/index.ts'
import type { Authorship, ParsedSource } from '../knowledge/types.ts'

export type Notebook = 'granola' | 'wispr'
export type NoteKind = 'meeting' | 'scratchpad'
export interface NotebookReply { content: string; structured: unknown }
export interface NoteItem { id: string; title: string; date: string }
export interface NotePreview extends NoteItem {
  parts: { label: string; text: string; role: Authorship }[]; link: string; modified: string
}
export const notebookLabel = { granola: 'Granola', wispr: 'Wispr Flow' }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const str = (v: unknown) => typeof v === 'string' ? v : ''
function data(reply: NotebookReply) { return object(reply.structured ?? JSON.parse(reply.content)) }
function xml(reply: NotebookReply) {
  const doc = new DOMParser().parseFromString('<results>' + reply.content + '</results>', 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Granola returned a note format Worldview could not read.')
  return doc
}
export function noteResults(key: Notebook, kind: NoteKind, reply: NotebookReply) {
  if (key === 'granola') {
    const doc = xml(reply)
    return { rows: [...doc.querySelectorAll('meetings_data > meeting')].map(e => ({ id: e.getAttribute('id') ?? '', title: e.getAttribute('title') || 'Untitled meeting', date: e.getAttribute('meeting_at') ?? '' })).filter(r => r.id), next: doc.querySelector('pagination')?.getAttribute('next_cursor') ?? '' }
  }
  const result = data(reply), items = result[kind === 'scratchpad' ? 'notes' : 'meetings']
  if (!Array.isArray(items)) throw new Error('Wispr Flow returned an unexpected list.')
  return { rows: items.map(object).map(r => ({ id: str(r.id), title: str(r.title) || 'Untitled note', date: str(r.start || r.modified_at) })).filter(r => r.id), next: str(result.next_cursor) }
}
export function notePreview(key: Notebook, kind: NoteKind, row: NoteItem, reply: NotebookReply): NotePreview {
  const parts: NotePreview['parts'] = []
  function add(label: string, text: unknown, role: Authorship) { if (typeof text === 'string' && text.trim()) parts.push({ label, text: text.trim(), role }) }
  let note: NotePreview
  if (key === 'granola') {
    const element = [...xml(reply).querySelectorAll('meetings_data > meeting')].find(el => el.getAttribute('id') === row.id)
    if (!element) throw new Error('This meeting is no longer available.')
    const privateNotes = element.querySelector('private_notes')
    if (privateNotes && !['empty','not_included'].includes(privateNotes.getAttribute('status') ?? '')) add('Private notes', privateNotes.textContent, 'unknown')
    add('Meeting summary', element.querySelector('summary')?.textContent, 'assistant')
    note = { ...row, title: element.getAttribute('title') || row.title, parts, link: element.getAttribute('url') ?? '', modified: element.getAttribute('updated_at') ?? '', date: element.getAttribute('meeting_at') || row.date }
  } else {
    const r = data(reply)
    if (r.id !== row.id) throw new Error('Wispr Flow returned a different note. Select the note again.')
    const text = str(r.content), excerpt = text.length > 40000 || /start_char\s*[=:]\s*\d+.{0,100}$/i.test(text)
    const label = kind === 'scratchpad' ? 'Scratchpad' : 'Meeting notes'
    add(excerpt ? label + ' (provider excerpt)' : label, text, 'unknown')
    add('Flow summary', r.summary, 'assistant')
    note = { ...row, title: str(r.title) || row.title, parts, link: str(r.share_link), modified: str(r.modified_at), date: str(r.start) || row.date }
  }
  if (!parts.length) throw new Error('The provider returned no note text for this item.')
  return note
}
export async function keepNotebookNote(key: Notebook, kind: NoteKind, preview: NotePreview, stillOpen: () => boolean) {
  const store = getStore(), generation = getWorldGeneration()
  const current = () => stillOpen() && isRepoReady() && getStore() === store && getWorldGeneration() === generation
  const date = kind === 'scratchpad' ? NaN : Date.parse(preview.date), authoredAt = Number.isFinite(date) ? date : null
  const parsed: ParsedSource = { externalId: 'notebook:' + key + ':' + kind + ':' + preview.id, title: preview.title, kind: 'document', messages: [], text: '', authoredAt,
    metadata: { provider: notebookLabel[key], providerId: preview.id, noteKind: kind, providerModifiedAt: preview.modified, url: preview.link } }
  for (const part of preview.parts) {
    parsed.text += (parsed.text ? '\n\n' : '') + part.label + '\n'
    const start = parsed.text.length
    parsed.text += part.text
    parsed.messages.push({ text: part.text, start, end: parsed.text.length, role: part.role, authoredAt })
  }
  const original = new TextEncoder().encode(JSON.stringify({ provider: key, kind, ...preview }, null, 2))
  const id = 'knowledge-' + await knowledgeHash(original)
  await retainWorldBlob({ meta: { id, kind: 'file', mime: 'application/json', bytes: original.length, createdAt: Date.now(), nodeId: null }, data: original }, { store, generation, shouldWrite: current })
  return ingestRetainedSource(parsed, { originalName: key + '-' + preview.id + '.json', originalBlobId: id, origin: 'import', trackOriginalChanges: true, shouldWrite: current })
}
