import { useEffect, useRef, useState, type FormEvent } from 'react'

type ContactFields = { name: string; headline: string; phone: string }
type Suggestion = ContactFields & { id: string; url: string; source: string }
type ScreenState = { status: 'unavailable' | 'off' | 'permission' | 'watching' | 'paused'; suggestion: Suggestion | null; frame?: 'waiting' | 'readable' | 'unreadable' }
export interface ScreenContactBridge {
  screenState: () => Promise<ScreenState>
  screenStart: () => Promise<ScreenState>
  screenNow: () => Promise<ScreenState & { result?: 'found' | 'none' | 'unreadable' | 'unavailable' }>
  screenPause: () => Promise<ScreenState>
  screenSettings: () => Promise<void>
  screenRestart?: () => Promise<void>
  screenPaste?: (value: string) => Promise<ScreenState>
  screenDismiss: (id: string) => Promise<void>
  screenSave: (id: string, fields: ContactFields) => Promise<{ status: string; message?: string }>
  onScreenContacts: (callback: (state: ScreenState) => void) => () => void
}

function ScreenPreview({ contact, busy, focus, save, dismiss }: {
  contact: Suggestion; busy: boolean; focus: boolean
  save: (fields: ContactFields) => void; dismiss: () => void
}) {
  const [name, setName] = useState(contact.name)
  const [headline, setHeadline] = useState(contact.headline)
  const [phone, setPhone] = useState(contact.phone)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focus) field.current?.focus() }, [focus])
  const identifiable = !!(name.trim() || phone.trim())
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (identifiable) save({ name, headline, phone })
  }
  return <form className="enki-screen-preview" onSubmit={submit}>
    <h2>{contact.source === 'Pasted' ? 'Review contact' : contact.source === 'Phone number' ? 'Phone number spotted' : contact.source + ' contact spotted'}</h2>
    <label className="enki-field">Name<input ref={field} name="contactName" value={name} onChange={event => setName(event.target.value)} maxLength={120} autoComplete="off" /></label>
    {contact.phone && <label className="enki-field">Phone number<input name="contactPhone" type="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={32} autoComplete="off" /></label>}
    {!contact.phone && <label className="enki-field">Headline<input name="contactHeadline" value={headline} onChange={event => setHeadline(event.target.value)} maxLength={180} autoComplete="off" /></label>}
    <div className="enki-record-actions">
      <button type="submit" className="enki-primary" disabled={busy || !identifiable}>Collect contact</button>
      <button type="button" disabled={busy} onClick={dismiss}>Skip</button>
    </div>
  </form>
}

export function EnkiScreenContacts({ bridge }: { bridge: ScreenContactBridge }) {
  const [state, setState] = useState<ScreenState | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'scan' | 'action' | null>(null)
  const [paste, setPaste] = useState('')
  const [focusContact, setFocusContact] = useState(false)
  useEffect(() => {
    let live = true
    let updated = false
    const stop = bridge.onScreenContacts(value => { updated = true; if (live) setState(value) })
    void bridge.screenState().then(value => { if (live && !updated) setState(value) })
      .catch(() => { if (live && !updated) setError('Enki couldn’t check screen access. Reopen Worldview and try again.') })
    return () => { live = false; stop() }
  }, [bridge])

  async function act(action: () => Promise<void>, kind: 'scan' | 'action' = 'action') {
    if (busy) return
    setBusy(kind); setError(''); setMessage('')
    try { await action() }
    catch (cause) { setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { setBusy(null) }
  }
  const contact = state?.suggestion
  const status = state?.status
  const label = busy === 'scan' ? 'Scanning…' : status === 'permission' ? 'Access needed' : status === 'watching'
    ? state?.frame === 'unreadable' ? 'Display unavailable' : 'Screen scan on'
    : status === 'paused' ? 'Paused' : status === 'off' ? 'Screen scan off' : status === 'unavailable' ? 'Mac only' : 'Checking access…'
  const start = () => void act(async () => setState(await bridge.screenStart()))
  const scan = () => void act(async () => {
    setFocusContact(true)
    const next = await bridge.screenNow()
    setState(next)
    if (!next.suggestion) {
      setFocusContact(false)
      setMessage(next.result === 'none' ? 'No contact found. Bring the profile or number into view and scan again.' :
        next.status === 'watching' ? 'No readable image came back from macOS. Try again or paste the contact below.' : '')
    }
  }, 'scan')
  return <section className="enki-screen-contacts" aria-label="Screen contact suggestions">
    <div className="enki-capture-card" data-state={status} aria-busy={busy === 'scan'}>
      <div className="enki-capture-card-top"><h1>Contact suggestions</h1><span className="enki-capture-state" data-scanning={busy === 'scan' || undefined}>{label}</span></div>
      {status === 'permission' && <p>macOS hasn’t granted this running copy screen access. If Worldview is already enabled in Settings, reopen it. After an update you may need to switch access off and back on.</p>}
      {status === 'off' && <p>Spot profiles and phone numbers on your screen. Review them before adding them to People.</p>}
      {status === 'watching' && !contact && <p>Looking for LinkedIn, Instagram, WhatsApp, and visible phone numbers.</p>}
      {status === 'paused' && <p>Screen reading resumes when you return to your Mac.</p>}
      {status === 'unavailable' && <p>Screen suggestions are available in Worldview for Mac.</p>}
      <div className="enki-capture-actions">
        {status === 'off' && <button type="button" data-primary disabled={!!busy} onClick={start}>Enable screen suggestions</button>}
        {status === 'permission' && <>
          {bridge.screenRestart && <button type="button" data-primary disabled={!!busy} onClick={() => void act(() => bridge.screenRestart!())}>Reopen Worldview</button>}
          <button type="button" disabled={!!busy} onClick={() => void act(() => bridge.screenSettings())}>Open Settings</button>
          <button type="button" disabled={!!busy} onClick={start}>Check access</button>
        </>}
        {status === 'watching' && !contact && <button type="button" data-primary disabled={!!busy} onClick={scan}>{busy === 'scan' ? 'Scanning…' : 'Scan now'}</button>}
        {(status === 'watching' || status === 'paused') && <button type="button" disabled={!!busy} onClick={() => void act(async () => setState(await bridge.screenPause()))}>Pause</button>}
      </div>
    </div>
    {contact && <ScreenPreview key={contact.id} contact={contact} busy={!!busy} focus={focusContact} dismiss={() => void act(async () => {
      setFocusContact(false)
      await bridge.screenDismiss(contact.id)
    })} save={fields => void act(async () => {
      const result = await bridge.screenSave(contact.id, fields)
      setFocusContact(false)
      setMessage(result.status === 'saved' ? 'Contact saved to People.' : result.status === 'existing' ? 'This contact is already in People.' : result.message || 'Check this contact in People before saving.')
    })} />}
    {!!message && <p className="enki-capture-feedback" role="status">{message}</p>}
    {!!error && <p className="enki-help-error" role="alert">{error}</p>}
    {!contact && bridge.screenPaste && <details className="enki-paste-contact">
      <summary>Paste contact details</summary>
      <form onSubmit={event => {
        event.preventDefault()
        void act(async () => { setFocusContact(true); setState(await bridge.screenPaste!(paste)); setPaste('') })
      }}>
        <label className="enki-field">Name, phone number or LinkedIn or Instagram link
          <textarea rows={2} maxLength={2000} value={paste} onChange={event => setPaste(event.target.value)} />
        </label>
        <button type="submit" disabled={!!busy || !paste.trim()}>Review contact</button>
      </form>
    </details>}
  </section>
}
