import { useEffect, useState } from 'react'
import { BOOKSHELF_KV, type BookshelfSnapshot, type ShelfBook } from '../bookshelf/types.ts'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { WorldStateConflictError } from '../data/worldState.ts'
import { decodeQuotes, emptyLibrary, QUOTES_KV, updateQuote, type Corpus, type QuoteInput, type QuoteRevision } from './model.ts'

const emptyCorpus = (): Corpus => ({ sources: [], versions: [], passages: [] })
const emptyView = () => ({ library: emptyLibrary(), corpus: emptyCorpus(), books: [] as ShelfBook[], loaded: false, error: '' })
export function quoteScope() {
  if (!isRepoReady()) throw new Error('Open a workspace to use quotes.')
  return { store: getStore(), generation: getWorldGeneration() }
}
type Scope = ReturnType<typeof quoteScope>
function current(scope: Scope) {
  return isRepoReady() && getStore() === scope.store && getWorldGeneration() === scope.generation
}
export function useQuoteLibrary(includeSources = false) {
  const ready = useRepoStatus(s => s.ready), writer = useRepoStatus(s => s.writer)
  const [view, setView] = useState(emptyView)
  useEffect(() => {
    let active = true, ticket = 0
    if (!ready) { setView(emptyView()); return }
    async function load() {
      const count = ++ticket
      try {
        const scope = quoteScope()
        const [raw, corpus, shelf] = await Promise.all([
          scope.store.getKv(QUOTES_KV),
          includeSources ? scope.store.getKv<Corpus>('knowledge.v1') : undefined,
          includeSources ? scope.store.getKv<BookshelfSnapshot>(BOOKSHELF_KV) : undefined,
        ])
        if (active && count === ticket && current(scope)) {
          setView({ library: decodeQuotes(raw), corpus: corpus || emptyCorpus(), books: shelf?.books ?? [], loaded: true, error: '' })
        }
      } catch (cause) {
        if (active && count === ticket) setView({ ...emptyView(), error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    void load()
    const stop = subscribeRepo(change => {
      if (change.type === 'wipe' || change.type === 'import') { setView(emptyView()); void load() }
      else if (change.type === 'kv' && change.keys.some(k => k === QUOTES_KV || includeSources && (k === 'knowledge.v1' || k === BOOKSHELF_KV))) void load()
    })
    return () => { active = false; stop() }
  }, [ready, includeSources])
  return { ...view, writer }
}
export async function saveQuote(scope: Scope, id: string, action: QuoteRevision['action'], input: QuoteInput, expectedHistoryLength?: number) {
  const at = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!current(scope)) throw new Error('The workspace changed. Reopen the quotation before saving.')
    if (!useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport) throw new Error('Open the writer window and finish any pending restore before saving.')
    const [raw, corpus, shelf] = await Promise.all([
      scope.store.getKv(QUOTES_KV), scope.store.getKv<Corpus>('knowledge.v1'),
      input.source.bookId ? scope.store.getKv<BookshelfSnapshot>(BOOKSHELF_KV) : undefined,
    ])
    if (!current(scope)) throw new Error('The workspace changed. Reopen the quotation before saving.')
    const library = decodeQuotes(raw), revision = library.revision
    if (expectedHistoryLength !== undefined && library.quotes.find(q => q.id === id)?.history.length !== expectedHistoryLength) {
      throw new Error('This reference changed. Reopen it to review the latest version.')
    }
    const book = shelf?.books.find(b => b.id === input.source.bookId)
    if (action === 'captured' && input.source.bookId && (!book || book.catalog?.editionId !== input.source.catalogEditionId || book.sourceId !== input.source.sourceId || book.sourceVersionId && book.sourceVersionId !== input.source.versionId)) {
      throw new Error('This saved edition changed. Choose its current entry before saving.')
    }
    updateQuote(library, input, corpus || emptyCorpus(), at, id, action, book)
    if (revision === library.revision) return
    try {
      await compareAndSwapWorldState(QUOTES_KV, library, revision)
      return
    } catch (error) {
      if (!(error instanceof WorldStateConflictError) || attempt === 2) throw error
    }
  }
}
