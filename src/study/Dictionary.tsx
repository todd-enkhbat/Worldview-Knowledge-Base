import { useCallback, useEffect, useState } from 'react'
import { Lookup, study } from './StudyDesk'
import type { StudyState, WordContext, WordEntry } from './model'

export type DictionarySelection = { text: string; context: WordContext; serial: number }

export function Dictionary({ selection }: { selection: DictionarySelection | null }) {
  const [recent, setRecent] = useState<WordEntry[] | null>(null)
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    try {
      const { words } = await study<StudyState>('state')
      setRecent(words.sort((a, b) => (b.encounters.at(-1)?.at || 0) - (a.encounters.at(-1)?.at || 0)).slice(0, 5))
      setMessage('')
    } catch { setMessage('Recent words could not be loaded.') }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  return <>
    <h1>Dictionary</h1>
    <Lookup key={selection?.serial || 0} fieldLabel="Word or phrase" initial={selection?.text} context={selection?.context} changed={refresh} />
    {!!recent?.length && <section className="enki-recent"><h2>Recent words</h2>{recent.map(word => (
      <details key={word.id}><summary>{word.term}</summary><p>{word.senses[word.selected]?.meaning}</p></details>
    ))}</section>}
    {recent?.length === 0 && <p className="enki-hint">Looked-up words are saved to your vocabulary.</p>}
    {message && <p role="status" className="enki-hint">{message} <button onClick={refresh}>Retry</button></p>}
  </>
}
