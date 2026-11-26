import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { exportArchive, importArchive, blobSink, readArchive } from '../../src/data/archive.ts'
import { createShelfBook, emptyBookshelf } from '../../src/bookshelf/model.ts'
import { newWritingDraft } from '../../src/writing/store.ts'
import { emptyLibrary, updateQuote } from '../../src/quotes/model.ts'
import {
  applyStudy,
  decodeStudy,
  STUDY_KEY,
  parseApplicationPaste,
  answerRelevance
} from '../../src/study/model.ts'

describe('reading and reuse across an actual portable archive', () => {
  it('retains the edition, chapter, quote, distinct encounters, review and answer revisions', async () => {
    const store = createMemoryStore(),
      book = createShelfBook({ title: 'Discourses on Livy', isbn: '9780140444285' })
    const note = newWritingDraft({
      bookEditionId: book.id,
      chapter: 'Book I, Chapter 3',
      title: 'Fortune',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Virtù' }] }] }
    })
    const quotes = emptyLibrary()
    updateQuote(
      quotes,
      {
        text: 'Virtù',
        source: {
          title: book.title,
          locator: note.chapter!,
          edition: 'My paper copy',
          author: 'Machiavelli',
          bookId: book.id
        },
        origin: { kind: 'book', id: book.id, title: book.title }
      },
      { sources: [], versions: [], passages: [] },
      123,
      'quotation',
      'captured',
      book
    )
    const state = decodeStudy(undefined)
    const event = {
      term: 'Virtù',
      language: 'it',
      senses: [{ pos: 'noun', meaning: 'virtue' }],
      context: { bookId: book.id, noteId: note.id, chapter: note.chapter, sentence: 'Virtù appears here.' },
      eventId: 'first',
      source: 'Test dictionary'
    }
    const id = applyStudy(state, 'encounter', event, 123)
    applyStudy(state, 'encounter', event, 123)
    applyStudy(
      state,
      'encounter',
      { ...event, term: 'virtù', eventId: 'second', context: { url: 'https://example.org/article' } },
      134
    )
    applyStudy(state, 'review', { id, grade: 'hard' }, 145)
    const text = 'Why apply?\nFirst paragraph.\n\nSecond paragraph.'
    const application = {
      organization: 'Test',
      opportunity: 'Fellowship',
      step: 'One',
      source: 'Chosen file',
      submitted: false,
      answers: parseApplicationPaste(text)
    }
    const appId = applyStudy(state, 'application', application, 150)
    applyStudy(state, 'application', { ...application, id: appId }, 155)
    applyStudy(
      state,
      'application',
      { ...application, id: appId, answers: [{ question: 'Why apply?', answer: 'A revised answer.' }] },
      160
    )
    expect(state.applications[0].revisions).toHaveLength(2)
    expect(state.words[0].encounters).toHaveLength(2)
    expect(state.words[0].history).toEqual([{ grade: 'hard', at: 145 }])
    await store.putKv('bookshelves.v1', { ...emptyBookshelf(), books: [book] })
    await store.putKv('quotes.v1', quotes)
    await store.putKv('writing.v1', { schemaVersion: 1, revision: 1, docs: [note] })
    await store.putKv(STUDY_KEY, state)
    const sink = blobSink()
    await exportArchive(store, sink)
    const archive = await readArchive(sink.blob())
    const restored=createMemoryStore()
    await importArchive(restored,sink.blob(),{allowWithoutBackup:true})
    expect(decodeStudy(await restored.getKv(STUDY_KEY))).toEqual(decodeStudy(state))
    expect(await restored.getKv('writing.v1')).toEqual(archive.kv['writing.v1'])
    expect(decodeStudy(archive.kv[STUDY_KEY])).toEqual(decodeStudy(state))
    expect(archive.kv['bookshelves.v1']).toMatchObject({ books: [{ id: book.id }] })
    expect(archive.kv['writing.v1']).toMatchObject({
      docs: [{ id: note.id, bookEditionId: book.id, chapter: note.chapter }]
    })
    expect(archive.kv['quotes.v1']).toEqual(quotes)
    expect(state.applications[0].revisions[0].answers[0].answer).toBe('First paragraph.\n\nSecond paragraph.')
    expect(
      answerRelevance('Tell us why you applied for the fellowship', 'Why this fellowship?', '', '')
    ).toBeGreaterThan(0)
    applyStudy(state, 'remove-card', { id })
    expect(state.words[0].encounters).toHaveLength(2)
    applyStudy(state, 'undo', { id, eventId: 'second' })
    expect(state.words[0].encounters).toHaveLength(1)
  })
})
