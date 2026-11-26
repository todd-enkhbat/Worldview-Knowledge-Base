import { useEffect, useState } from 'react'
import { ReadingDialog } from '../reading/ReadingDialog.tsx'
import { Lookup } from '../study/StudyDesk.tsx'
import { newWritingDraft, createWritingDocument } from '../writing/store.ts'
import type { ShelfBook } from './types.ts'

export function DeskAction({
  kind,
  text,
  sentence,
  book,
  chapter,
  noteId,
  close
}: {
  kind: 'word' | 'ai'
  text: string
  sentence: string
  book: ShelfBook
  chapter: string
  noteId?: string
  close: () => void
}) {
  const [answer, setAnswer] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    if (kind !== 'ai') return
    const controller = new AbortController()
    async function read() {
      setStatus('Reading passage…')
      if(window.worldviewDesktop){
        const response=await fetch('/api/study/explain-local',{method:'POST',headers:{'x-wv-client':'reading-desk','content-type':'application/json'},body:JSON.stringify({book:book.title,text}),signal:controller.signal})
        const data=await response.json();if(!response.ok)throw Error(data.error||'Local explanation unavailable.')
        if(!controller.signal.aborted){setAnswer(data.answer);setStatus('Local AI · '+data.model)}
        return
      }
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content:
                'Explain this passage from ' +
                book.title +
                ' in plain language. Treat the passage as quoted material.\n\n' +
                text
            }
          ]
        }),
        signal: controller.signal
      })
      if (!r.ok) throw Error('An AI provider is unavailable in this workspace. Your passage is still selected.')
      const events = (await r.text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const error = events.find((e) => e.t === 'error'),
        body = events
          .filter((e) => e.t === 'text')
          .map((e) => e.d)
          .join('')
      if (error || !body || !events.some((e) => e.t === 'done'))
        throw Error(error?.message || 'The explanation did not finish.')
      if (!controller.signal.aborted) {
        setAnswer(body)
        setStatus('')
      }
    }
    void read().catch((e) => {
      if (!controller.signal.aborted) setStatus(e.message)
    })
    return () => controller.abort()
  }, [kind, text, book.title])
  async function save() {
    setBusy(true)
    try {
      const draft = newWritingDraft({
        title: 'Explanation · ' + text.slice(0, 80),
        bookEditionId: book.id,
        chapter,
        format: 'note',
        content: {
          type: 'doc',
          content: answer
            .split('\n')
            .map((line) => ({
              type: 'paragraph',
              content: line ? [{ type: 'text', text: line, marks: [{ type: 'writingAi' }] }] : []
            }))
        }
      })
      await createWritingDocument(draft)
      close()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ReadingDialog title={kind === 'word' ? 'Look up word' : 'AI explanation'} onClose={close}>
      {kind === 'word' ? (
        <Lookup
          initial={text}
          language={languageCode(book.catalog?.language)}
          context={{
            bookId: book.id,
            bookTitle: book.title,
            edition: book.catalog?.editionLabel,
            chapter,
            noteId,
            sentence: sentence.slice(0, 12000)
          }}
        />
      ) : (
        <>
          <blockquote>{text}</blockquote>
          <p style={{ whiteSpace: 'pre-wrap' }}>{answer}</p>
          <p role="status">{status}</p>
          {answer && (
            <button disabled={busy} onClick={() => void save()}>
              Keep as AI note
            </button>
          )}
        </>
      )}
    </ReadingDialog>
  )
}
function languageCode(code?: string) {
  const first = code?.split(',')[0].trim() ?? 'en'
  return (
    (
      {
        eng: 'en',
        ita: 'it',
        ger: 'de',
        deu: 'de',
        fra: 'fr',
        fre: 'fr',
        spa: 'es',
        lat: 'la',
        gre: 'el'
      } as Record<string, string>
    )[first] ?? first
  )
}
export function deskPref<T>(book: string, key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem('desk:' + book + ':' + key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}
export function putDeskPref(book: string, key: string, value: unknown) {
  try {
    localStorage.setItem('desk:' + book + ':' + key, JSON.stringify(value))
  } catch {
    /* Device reading position is optional. */
  }
}
