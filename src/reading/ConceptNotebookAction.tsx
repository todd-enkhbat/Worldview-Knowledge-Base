import { useState } from 'react'
import { ArrowCounterClockwise, Notebook, NotePencil } from '@phosphor-icons/react'
import { getWorldGeneration } from '../data/repo.ts'
import { conceptNoteId, openConceptNote, useWriting } from '../writing/store.ts'
import { createTopic } from './store.ts'
import type { CanonicalTopic } from './topics.ts'

const noteHref = (id: string) => '#/write?doc=' + encodeURIComponent(id)

export function ConceptNotebookAction({ topic, disabled }: { topic: CanonicalTopic; disabled: boolean }) {
  const existing = useWriting(state => state.docs.find(doc => doc.id === conceptNoteId(topic.id)))
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  if (existing && existing.archivedAt === null) return <a className="knowledge-button is-primary" href={noteHref(existing.id)}><Notebook size={16} />Open concept note</a>

  async function write() {
    const generation = getWorldGeneration(), hash = location.hash
    const current = () => getWorldGeneration() === generation && location.hash === hash
    setPending(true); setError('')
    try {
      // A source tag can have a concept page before it has a permanent topic ID.
      const id = topic.readingTopicIds.length ? topic.id : (await createTopic(topic.name)).id
      if (!current()) return
      const saved = await openConceptNote(id, !!existing)
      if (current()) location.hash = noteHref(saved.id)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : 'Could not open your concept note.')
    } finally { setPending(false) }
  }
  return <><button className="knowledge-button is-primary" type="button" disabled={disabled || pending} onClick={() => void write()}>
    {existing ? <ArrowCounterClockwise size={16} /> : <NotePencil size={16} />}{existing ? 'Restore concept note' : 'Write about ' + topic.name}
  </button>{error && <small role="alert">{error}</small>}</>
}
