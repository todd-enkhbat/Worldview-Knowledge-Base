import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Planet, Leaf, Sparkle, UploadSimple } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { completeFirstRun, importWorld, useRepoStatus } from '../data/repo.ts'
import { MS_PER_YEAR } from '../domain/constants.ts'
import { parseDateInput, t0Problem } from './durability.ts'
import { Overlay, trapKeys } from './DurabilityKit.tsx'

function Welcome() {
  const writer = useRepoStatus((s) => s.writer)
  const [start, setStart] = useState<'empty' | 'demo'>('empty')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    useApp.setState((s) => ({
      mode: 'orbit', prevMode: 'orbit', selectedId: null, hoveredId: null, focusedId: null,
      panels: Object.fromEntries(Object.keys(s.panels).map((key) => [key, false])) as typeof s.panels,
      editor: { open: false, nodeId: null, archetype: null }, toasts: [],
      clock: { ...s.clock, playing: false },
    }))
    heading.current?.focus()
  }, [])
  async function enter(e: FormEvent) {
    e.preventDefault()
    if (!writer || busy) return
    setError('')
    const now = Date.now()
    // Leave room for a lifetime of memories without requiring personal information.
    let T0 = now - 30 * MS_PER_YEAR
    if (date.trim()) {
      const parsed = parseDateInput(date)
      if (!parsed.ok) { setError(parsed.message); return }
      const problem = t0Problem(parsed.epochMs, now)
      if (problem) { setError(problem); return }
      T0 = parsed.epochMs
    }
    setBusy(true)
    try {
      useApp.getState().setView({ world: 'field' })
      await completeFirstRun({ T0, start })
      useApp.getState().togglePanel('chat', true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false) }
  }
  async function restore(file: File) {
    setBusy(true); setError('')
    try {
      const world = useWorld.getState()
      await importWorld(file, { allowWithoutBackup: world.nodes.size === 0 && world.trash.size === 0 })
      const imported = useWorld.getState().settings
      if (!imported?.firstRunComplete) await completeFirstRun({ T0: imported?.T0 ?? Date.now() - 30 * MS_PER_YEAR, start: 'empty' })
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false) }
  }
  return <Overlay><div className="welcome" ref={ref} role="dialog" aria-modal="true" aria-labelledby="welcome-title" onKeyDown={(e) => trapKeys(e, ref.current, null)}>
    <section className="welcome-world" aria-hidden="true"><div className="welcome-brand"><Planet size={30} weight="duotone" />Worldview</div><div className="welcome-galaxy"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="welcome-world-caption"><span>A place for the way you think.</span><p>Thoughts take shape.<br />Connections become a world.</p></div></section>
    <section className="welcome-content"><div className="welcome-mobile-brand"><Planet size={24} />Worldview</div><form onSubmit={(e) => void enter(e)}>
      <span className="welcome-eyebrow"><Leaf size={17} /> Your personal second brain</span>
      <h1 ref={heading} tabIndex={-1} id="welcome-title">Make room<br />for your mind.</h1>
      <p className="welcome-intro">Bring your thoughts, memories, and files together. Discover the connections in a living world that grows with you.</p>
      <fieldset className="welcome-choices"><legend>How would you like to begin?</legend><label className={start === 'empty' ? 'is-selected' : ''}><input type="radio" name="start" checked={start === 'empty'} onChange={() => setStart('empty')} /><span><strong>Make it my own</strong><small>Start with a thought, a file, or a conversation.</small></span></label><label className={start === 'demo' ? 'is-selected' : ''}><input type="radio" name="start" checked={start === 'demo'} onChange={() => setStart('demo')} /><span><strong>Look around first</strong><small>Explore an example world with connected notes.</small></span><Sparkle size={19} /></label></fieldset>
      <details className="welcome-time"><summary>Have older memories to bring in?</summary><label htmlFor="world-start">Earliest year or date in your world</label><input id="world-start" value={date} onChange={(e) => setDate(e.target.value)} placeholder="e.g. 1995" autoComplete="off" /><small>Optional. We leave 30 years of history by default. You can change this in Settings.</small></details>
      {error && <p className="product-error" role="alert">{error}</p>}
      {!writer && <p className="product-error" role="alert">Another tab is editing this world. Close it to continue here.</p>}
      <button className="product-primary welcome-enter" type="submit" disabled={busy || !writer}>{busy ? 'Growing your world…' : 'Step into your world'}<ArrowRight size={18} /></button>
      <button className="welcome-restore" type="button" disabled={busy || !writer} onClick={() => fileRef.current?.click()}><UploadSimple size={15} />Restore a Worldview backup</button>
      <input ref={fileRef} hidden type="file" accept=".zip,application/zip" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restore(f) }} />
      <p className="welcome-privacy">Your world is saved on this device. Export a backup in Settings to keep another copy. AI is optional; sending a message shares it with the AI service.</p>
    </form></section>
  </div></Overlay>
}

export function FirstRun() {
  const ready = useRepoStatus((s) => s.ready)
  const settings = useWorld((s) => s.settings)
  return ready && !settings?.firstRunComplete ? <Welcome /> : null
}
