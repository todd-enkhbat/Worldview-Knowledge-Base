import { useMemo, useState } from 'react'
import { useWorld } from '../app/store.ts'
import { createNode, useRepoStatus } from '../data/repo.ts'
import { fitDate } from '../ai/chat/apply.ts'
import { selectAndFly } from './shortcuts.ts'
import { ProductDialog } from './ProductDialog.tsx'
import './Reflection.css'

const PROMPTS = [
  'What has been taking up space in your mind today?',
  'What changed the way you saw something today?',
  'What do you want to remember about this moment?',
  'What question keeps coming back to you?',
  'What connection did you notice that you had not seen before?',
  'What gave you energy today, and what took it away?',
  'What are you becoming more certain about? Less certain about?',
]
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function Reflection({ onClose }: { onClose: () => void }) {
  const writer = useRepoStatus((s) => s.writer)
  const nodes = useWorld((s) => s.nodes)
  const settings = useWorld((s) => s.settings)
  const [prompt, setPrompt] = useState(() => Math.floor(Date.now() / 86_400_000) % PROMPTS.length)
  const [answer, setAnswer] = useState('')
  const [date, setDate] = useState(() => localDay(new Date()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const history = useMemo(() => [...nodes.values()].filter((n) => n.tags.includes('daily-reflection')).sort((a, b) => b.temporalOrigin - a.temporalOrigin).slice(0, 8), [nodes])

  async function save() {
    if (!answer.trim() || !settings || busy) return
    setBusy(true)
    setError(null)
    try {
      const entered = new Date(`${date}T12:00:00`).getTime()
      if (!Number.isFinite(entered)) throw new Error('Choose a valid date for your reflection.')
      const displayDate = new Date(entered).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      const now = Date.now()
      const fitted = fitDate(entered, 'day', settings, now)
      const record = await createNode({
        archetype: 'idea', title: `Reflection · ${displayDate}`,
        contentMd: `## ${PROMPTS[prompt]}\n\n${answer.trim()}`,
        tags: ['daily-reflection'], ...fitted,
        thermo: { mass: 1, temperature: 0.3 },
        provenance: { source: 'chat', keptAt: now },
      })
      setSavedId(record.id)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  function view(id: string) { selectAndFly(id); onClose() }

  return (
    <ProductDialog title="A moment for your mind" description="Small thoughts become part of a bigger picture." onClose={onClose}>
      {savedId ? <div className="reflection-saved" role="status"><span className="reflection-orb" aria-hidden="true" /><h3>Your thought has a place now.</h3><p>Saved in your world with its date. You can revisit it, connect it, or change it whenever you want.</p><button className="product-button primary" type="button" onClick={() => view(savedId)}>Find it in my world</button><button className="product-button" type="button" onClick={() => { setSavedId(null); setAnswer(''); setPrompt((p) => (p + 1) % PROMPTS.length) }}>Add another thought</button></div> : <form className="reflection-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="reflection-prompt"><span>Today’s invitation</span><h3>{PROMPTS[prompt]}</h3><button type="button" onClick={() => setPrompt((p) => (p + 1) % PROMPTS.length)}>Try another question</button></div>
        <label className="sr-only" htmlFor="reflection-answer">Your reflection</label>
        <textarea id="reflection-answer" className="product-input reflection-answer" autoFocus rows={6} placeholder="There’s no right answer. Start anywhere…" value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={!writer || busy} required />
        <div className="reflection-controls"><label htmlFor="reflection-date">Place in time<input id="reflection-date" className="product-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} min={settings ? localDay(new Date(settings.T0)) : undefined} max={localDay(new Date())} required disabled={!writer || busy} /></label><button className="product-button primary" type="submit" disabled={!writer || busy || !answer.trim()}>{busy ? 'Saving…' : 'Keep this thought'}</button></div>
        <p className="reflection-privacy">Saved directly to your world. This reflection is not sent to an AI service.</p>
      </form>}
      {!writer && <p className="product-error" role="alert">This world is read-only in this tab. Open the writing tab to save a reflection.</p>}
      {error && <p className="product-error" role="alert">{error}</p>}
      {history.length > 0 && <section className="reflection-history"><h3>Earlier reflections</h3>{history.map((n) => <button key={n.id} type="button" onClick={() => view(n.id)}><span><strong>{n.title}</strong><small>{n.contentMd.replace(/^##[^\n]*\n\n/, '').slice(0, 130)}</small></span><span aria-hidden="true">↗</span></button>)}</section>}
    </ProductDialog>
  )
}
