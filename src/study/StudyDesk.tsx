import { Discovery } from './Discovery.tsx'
import { applicationDeadline } from './applicationMetadata.ts'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  safeApplicationText, parseApplicationPaste,
  answerRelevance, applicationAppliedAt,
  normalizeTerm,
  type StudyState,
  type Sense,
  type WordContext,
  type WordEntry,
  type ApplicationInput
} from './model.ts'
import './study.css'

export async function study<T>(action: string, body?: unknown): Promise<T> {
  const result = await fetch('/api/study/' + action, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-wv-client': 'study-desk', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await result.json()
  if (!result.ok) throw Error(data.error || 'This workspace could not save your change.')
  return data
}
type Definition = { language: string; name: string; senses: Sense[]; source: string }
const explain = (e: unknown) => (e instanceof Error ? e.message : String(e))
export function Lookup({
  initial = '',
  language = 'en',
  context = {},
  fieldLabel = 'Dictionary',
  changed
}: {
  initial?: string
  language?: string
  context?: WordContext
  fieldLabel?: string
  changed?: () => void
}) {
  const [term, setTerm] = useState(initial),
    [preferred, setPreferred] = useState(language),
    [result, setResult] = useState<Definition[]>([]),
    [shown, setShown] = useState<Definition | null>(null),
    [msg, setMsg] = useState(''),
    [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ id: string; eventId: string } | null>(null),
    [looked, setLooked] = useState(initial)
  const started = useRef(false),
    lock = useRef(false)
  async function keep(row: Definition, value: string) {
    const eventId = crypto.randomUUID(),
      { id } = await study<{ id: string }>('encounter', {
        term: value,
        language: row.language,
        senses: row.senses,
        source: row.source,
        context,
        eventId
      })
    setReceipt({ eventId, id })
    setShown(row)
    setMsg('Saved to vocabulary')
    changed?.()
  }
  async function lookup() {
    if (lock.current || !term.trim()) return
    lock.current = true
    setBusy(true)
    setReceipt(null)
    setMsg('Looking up…')
    setResult([])
    setShown(null)
    const value = term.trim()
    setLooked(value)
    try {
      let rows: Definition[]
      try {
        rows = await study('lookup', { term: value, language: preferred })
      } catch (error) {
        const stored = await study<StudyState>('state')
        rows = stored.words
          .filter((w) => normalizeTerm(w.term) === normalizeTerm(value))
          .map((w) => ({ language: w.language, name: w.language, senses: w.senses, source: w.source }))
        if (!rows.length) throw error
      }
      setResult(rows)
      if (!rows.length) {
        setMsg('No definition found. Try the base form or another spelling.')
        return
      }
      if (rows.length === 1 || rows.some((r) => r.language === preferred))
        await keep(rows.find((r) => r.language === preferred) ?? rows[0], value)
      else setMsg('Choose the language you encountered.')
    } catch (e) {
      setMsg(explain(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const lookupSelection = useEffectEvent(lookup)
  useEffect(() => {
    if (initial && !started.current) {
      started.current = true
      void lookupSelection()
    }
  }, [initial]) // lookup only on the initial selection
  return (
    <div className="study-lookup">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void lookup()
        }}
      >
        <label>
          {fieldLabel}
          <input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            maxLength={160}
            placeholder="Enter a word or phrase…"
          />
        </label>
        <button disabled={busy || !term.trim()}>Look up</button>
      </form>
      {result.length > 1 && (
        <label>
          Language
          <select
            value={shown?.language ?? ''}
            disabled={busy}
            onChange={async (e) => {
              const row = result.find((r) => r.language === e.target.value)
              if (!row) return
              setBusy(true)
              try {
                if (receipt) await study('undo', receipt)
                setReceipt(null)
                setPreferred(row.language)
                await keep(row, looked)
              } catch (err) {
                setMsg(explain(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            <option value="" disabled>
              Choose language
            </option>
            {result.map((r) => (
              <option value={r.language} key={r.language}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {shown && (
        <article>
          <h3>{looked}</h3>
          <small>
            {shown.name} · {shown.source}
          </small>
          <ol>
            {shown.senses.map((sense, i) => (
              <li key={i}>
                <em>{sense.pos}</em> {sense.meaning}
              </li>
            ))}
          </ol>
          {context.sentence && <blockquote>{context.sentence}</blockquote>}
        </article>
      )}
      <div role="status">
        {msg}{' '}
        {receipt && (
          <button
            type="button"
            onClick={async () => {
              try {
                await study('undo', receipt)
                setReceipt(null)
                setMsg('Encounter removed')
                changed?.()
              } catch (e) {
                setMsg(explain(e))
              }
            }}
          >
            Undo
          </button>
        )}
      </div>
    </div>
  )
}
type Pack = { code: string; name: string; installed: boolean; count?: number; running?: boolean; error?: string }
function Packs() {
  const [packs, set] = useState<Pack[]>([]),
    [language, select] = useState('en'),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const read = () =>
      study<Pack[]>('packs')
        .then((data) => {
          if (active) set(data)
        })
        .catch((e) => {
          if (active) setError(explain(e))
        })
    void read()
    const t = setInterval(read, 4000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [])
  const p = packs.find((x) => x.code === language)
  return (
    <section>
      <label>
        Offline dictionary
        <select value={language} onChange={(e) => select(e.target.value)}>
          {packs.map((x) => (
            <option key={x.code} value={x.code}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!p || p.running || p.installed}
        onClick={async () => {
          try {
            await study('install', { language })
            set(await study<Pack[]>('packs'))
          } catch (e) {
            setError(explain(e))
          }
        }}
      >
        {p?.installed ? 'Installed' : p?.running ? 'Downloading…' : 'Download dictionary'}
      </button>
      <p role="status">
        {p?.error || error || (p?.running ? (p.count ?? 0).toLocaleString() + ' entries indexed' : '')}
      </p>
      <a href="https://kaikki.org/dictionary/" target="_blank" rel="noreferrer">
        Wiktionary via Kaikki · dictionary credits and licenses
      </a>
    </section>
  )
}
function readerDraft<T>(mode: string): T | null {
  try { return JSON.parse(sessionStorage.getItem('worldview-reader-' + mode) || 'null') } catch { return null }
}
function Vocabulary({ state, refresh }: { state: StudyState; refresh: () => void }) {
  const [selection] = useState(() => readerDraft<{term: string; url: string}>('word'))
  useEffect(() => { sessionStorage.removeItem('worldview-reader-word') }, [])

  const [filter, setFilter] = useState(''),
    [lang, setLang] = useState(''),
    [day, setDay] = useState(''),
    [card, setCard] = useState<string | null>(null),
    [flip, setFlip] = useState(false),
    [studyMode, setMode] = useState(false),
    [cloze, setCloze] = useState(false),
    [err, setErr] = useState('')
  const visible = state.words.filter(
    (w) =>
      (!lang || w.language === lang) &&
      w.encounters.some(
        (e) =>
          (!day || new Date(e.at).toLocaleDateString('sv-SE') === day) &&
          normalizeTerm([w.term, e.context.bookTitle, e.context.chapter, e.context.sentence].join(' ')).includes(
            normalizeTerm(filter)
          )
      )
  )
  const due = visible.filter((w) => w.due !== null && w.due <= Date.now()),
    active = due.find((w) => w.id === card) ?? due[0]
  async function change(action: string, body: unknown) {
    try {
      await study(action, body)
      refresh()
      setErr('')
    } catch (e) {
      setErr(explain(e))
    }
  }
  function front(w: WordEntry) {
    const encounter = w.encounters.find((e) =>
      e.context.sentence?.toLowerCase().includes(e.spelling.toLowerCase())
    )
    if (!cloze || !encounter) return w.term
    const line = encounter.context.sentence!,
      i = line.toLowerCase().indexOf(encounter.spelling.toLowerCase())
    return line.slice(0, i) + ' _____ ' + line.slice(i + encounter.spelling.length)
  }
  return (
    <>
      <Lookup initial={selection?.term} context={{url:selection?.url}} changed={refresh} />
      <details>
        <summary>Offline dictionaries</summary>
        <Packs />
      </details>
      <div className="study-tools">
        <input
          aria-label="Filter words and books"
          placeholder="Find a word or book"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select aria-label="Vocabulary language" value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="">All languages</option>
          {[...new Set(state.words.map((w) => w.language))].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <input aria-label="Date encountered" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        <button
          disabled={!due.length && !studyMode}
          onClick={() => {
            setMode(!studyMode)
            setFlip(false)
            setCard(null)
          }}
        >
          {studyMode ? 'End review' : 'Review · ' + due.length}
        </button>
      </div>
      {err && <p role="alert">{err}</p>}
      {studyMode ? (
        active ? (
          <article className="study-card">
            <label>
              <input type="checkbox" checked={cloze} onChange={(e) => setCloze(e.target.checked)} />
              Use my sentence
            </label>
            <h3>{front(active)}</h3>
            {flip ? (
              <>
                <p>{active.senses[active.selected]?.meaning}</p>
                <small>
                  {[
                    active.encounters.at(-1)?.context.bookTitle || active.encounters.at(-1)?.context.url,
                    active.encounters.at(-1)?.context.chapter,
                    active.source
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                <div>
                  {(['again', 'hard', 'got'] as const).map((grade, i) => (
                    <button
                      key={grade}
                      onClick={async () => {
                        await change('review', { id: active.id, grade })
                        setCard(due.find((w) => w !== active)?.id ?? null)
                        setFlip(false)
                      }}
                    >
                      {['Again', 'Hard', 'Got it'][i]}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button onClick={() => setFlip(true)}>Reveal meaning</button>
            )}
          </article>
        ) : (
          <p>Review complete.</p>
        )
      ) : (
        visible.map((w) => (
          <details key={w.id}>
            <summary>
              <strong>{w.term}</strong> · {w.senses[w.selected]?.meaning}
            </summary>
            <label>
              Meaning to study
              <select
                value={w.selected}
                onChange={(e) => void change('sense', { id: w.id, index: Number(e.target.value) })}
              >
                {w.senses.map((s, i) => (
                  <option key={i} value={i}>
                    {s.pos} · {s.meaning}
                  </option>
                ))}
              </select>
            </label>
            {w.encounters.map((e) => (
              <div key={e.id}>
                <p>{e.context.sentence}</p>
                {e.context.bookId ? (
                  <a
                    href={
                      '#/bookshelf?book=' +
                      encodeURIComponent(e.context.bookId) +
                      (e.context.noteId ? '&note=' + encodeURIComponent(e.context.noteId) : '')
                    }
                  >
                    {e.context.bookTitle}
                  </a>
                ) : (
                  e.context.url && <a href={e.context.url}>{e.context.url}</a>
                )}{' '}
                <small>
                  {[e.context.sourceApp, e.context.chapter, e.context.page, new Date(e.at).toLocaleString()]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </div>
            ))}
            {w.due !== null && (
              <button onClick={() => void change('remove-card', { id: w.id })}>Remove flashcard</button>
            )}
          </details>
        ))
      )}
    </>
  )
}
export const blankApplication = (): ApplicationInput => ({
  captureId: crypto.randomUUID(),
  organization: '',
  opportunity: '',
  step: 'Application',
  source: '',
  submitted: false,
  answers: []
})
export function Applications({
  state,
  refresh,
  adapt,
  native,
  helper = false,
  initialQuery = ''
}: {
  helper?: boolean
  initialQuery?: string
  state: StudyState
  refresh: () => void
  adapt?: (text: string, title: string, app: string) => Promise<void>
  native?: StudyNative
}) {
  const [captured] = useState(() => readerDraft<Pick<ApplicationInput, 'organization' | 'opportunity' | 'source' | 'answers'>>('application'))
  useEffect(() => { sessionStorage.removeItem('worldview-reader-application') }, [])
  const [entry, setEntry] = useState(() => ({ ...blankApplication(), ...captured })),
    [raw, setRaw] = useState(''),
    [edit, setEdit] = useState(!!captured),
    [q, setQ] = useState(initialQuery),
    [msg, setMsg] = useState(''),
    [files, setFiles] = useState<File[]>([]),
    [source, setSource] = useState('dia'),
    [formUrl, setFormUrl] = useState(''),
    [openingForm, setOpeningForm] = useState(false),
    [reading, setReading] = useState(false),
    [saving, setSaving] = useState(false)
  const opportunityField = useRef<HTMLInputElement>(null)
  const startCapture = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(edit)
  useEffect(() => {
    if (helper && edit) opportunityField.current?.focus({ preventScroll: true })
    else if (helper && wasEditing.current) startCapture.current?.focus({ preventScroll: true })
    wasEditing.current = edit
  }, [edit, helper])
  useEffect(() => {
    if (initialQuery) setQ(initialQuery)
  }, [initialQuery])
  const liveApplications = useRef(state.applications)
  liveApplications.current = state.applications
  const patch = (value: Partial<ApplicationInput>) => setEntry((old) => ({ ...old, ...value }))
  async function readForm() {
    if (!native || reading || saving) return
    setReading(true); setEdit(true); setMsg('Reading this application and its published details…')
    try {
      const { pageText, ...form } = await native.form(source)
      const visibleDeadline = applicationDeadline(pageText || '')
      let context: Partial<ApplicationInput> & {notice?:string} = {}
      try { context = await study('application-context', {source:form.source,organization:form.organization,opportunity:form.opportunity,hasAnswers:form.answers.length>0}) }
      catch { if (!visibleDeadline.deadline) context.notice='Form read. Published opportunity details could not be checked; you can retry.' }
      const matching = liveApplications.current.find(a => a.revisions.some(r => r.source === form.source))
      const answers = form.answers.length ? form.answers : form.submitted && matching?.revisions.at(-1)?.answers.length ? matching.revisions.at(-1)!.answers : context.answers || []
      const same = matching?.revisions.findLast(row=>row.source===form.source && row.answers.map(answer=>answer.question).join('\n')===answers.map(answer=>answer.question).join('\n'))
      setEntry(old => ({ ...blankApplication(), ...context, ...form, answers, id:matching?.id,
        captureId: !matching && old.source===form.source && !old.id ? old.captureId : crypto.randomUUID(),
        organization:matching?.organization || context.organization || form.organization,
        opportunity:matching?.opportunity || context.opportunity || form.opportunity,
        step:form.submitted ? 'Submission confirmation' : same?.step || (matching ? 'Step '+(new Set(matching.revisions.map(row=>row.step)).size+1) : 'Application'),
        submitted:form.submitted || !!matching?.revisions.some(row=>row.submitted),
        appliedAt:(matching ? applicationAppliedAt(matching) : null) || form.appliedAt,
        deadline:visibleDeadline.deadline || context.deadline || matching?.deadline || '',
        deadlineSource:visibleDeadline.deadline ? form.source : context.deadline ? context.deadlineSource : matching?.deadlineSource,
        deadlineEvidence:visibleDeadline.deadline ? visibleDeadline.deadlineEvidence : context.deadline ? context.deadlineEvidence : matching?.deadlineEvidence,
      }))
      setMsg(context.notice || (form.submitted ? 'Submission confirmation detected.' : answers.length + ' questions read. Details filled from the application page.'))
    } catch(error) {setMsg(explain(error))}
    finally {setReading(false)}
  }
  const requestRead = useEffectEvent(()=>void readForm())
  useEffect(()=>{
    const reread=()=>requestRead()
    const status=(event:Event)=>setMsg(String((event as CustomEvent).detail || ''))
    window.addEventListener('worldview:application-reread',reread)
    window.addEventListener('worldview:application-status',status)
    return ()=>{window.removeEventListener('worldview:application-reread',reread);window.removeEventListener('worldview:application-status',status)}
  },[])
  const autoRead = useRef(false)
  useEffect(() => {
    if (helper && native && !autoRead.current && !captured) {autoRead.current=true; void readForm()}
  })
  const parse = (text: string, name: string) => {
    const field = (label: string) =>
      new RegExp('(?:^|\\n)' + label + '\\s*:\\s*([^\\n]+)', 'i').exec(text)?.[1]?.trim() || ''
    patch({
      organization: entry.organization || field('(?:organization|company|institution)'),
      answers: parseApplicationPaste(text),evidence:safeApplicationText(text),
      source: name || entry.source,
      opportunity: entry.opportunity || field('(?:opportunity|program|fellowship|position)') || name
    })
    setEdit(true)
    setMsg(parseApplicationPaste(text).length?'Review the question and answer pairs.':'No application questions found. You can keep this as a supporting document.')
  }
  const focused = new URLSearchParams(location.hash.split('?')[1]).get('application')
  const answers = state.applications
    .filter((a) => !focused || q || a.id === focused)
    .flatMap((a) =>
      a.revisions.flatMap((r) =>
        r.answers.map((v, i) => ({ ...v, key: r.id + ':' + i, application: a, revision: r }))
      )
    )
    .reverse()
  const matches = answers
    .map(v => ({ ...v, score: answerRelevance(q, v.question, v.answer, v.application.organization + ' ' + v.application.opportunity) }))
    .filter(v => v.score > 0 && (!!q.trim() || !!focused || !!v.answer.trim()))
    .sort((a, b) => b.score - a.score || b.revision.at - a.revision.at)
  const field = (name: 'organization' | 'opportunity' | 'step' | 'source') => (
    <label key={name}>{name}<input ref={name === 'opportunity' ? opportunityField : undefined} name={name} value={entry[name]} onChange={e => patch({ [name]: e.target.value })} /></label>
  )
  const appendTo = (
    <label>
      Append to
      <select
        value={entry.id ?? ''}
        onChange={(e) => {
          const app = state.applications.find((a) => a.id === e.target.value)
          patch({
            id: app?.id,
            organization: app?.organization ?? '',
            opportunity: app?.opportunity ?? '',
            step: app ? 'Step ' + (new Set(app.revisions.map((r) => r.step)).size + 1) : 'Application'
          })
        }}
      >
        <option value="">New application</option>
        {state.applications.map((a) => (
          <option key={a.id} value={a.id}>
            {a.opportunity}
          </option>
        ))}
      </select>
    </label>
  )
  const captureScreen = native?.ocr && (
    <button
      onClick={async () => {
        try {
          const text = await native.ocr!()
          setRaw((old) => old + (old ? '\n' : '') + text)
          setMsg('Scroll to the next section and capture again, or review the text.')
        } catch (e) {
          setMsg(explain(e))
        }
      }}
    >
      Capture screen region
    </button>
  )
  const imports = edit && <>
    <label>
      Application text
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Paste the questions and your answers"
        rows={3}
      />
    </label>
    <button disabled={!raw.trim()} onClick={() => parse(raw, '')}>
      Review pasted text
    </button>
    <Discovery
      choose={(item) => {
        setRaw(item.text)
        patch({
          organization: entry.organization,
          opportunity: entry.opportunity || item.title,
          source: item.source,
          step: item.confirmation ? 'Submission confirmation' : parseApplicationPaste(item.text).length ? 'Imported document' : 'Supporting document',
          submitted: item.confirmation,
          answers: item.confirmation ? [] : parseApplicationPaste(item.text),
          evidence: safeApplicationText(item.text),
          sourceDate: item.date
        })
        setMsg(item.confirmation?'Confirmation found. Review before saving.':parseApplicationPaste(item.text).length?'Review the questions and your answers.':'Supporting document · No questions or answers detected.')
      }}
    />
    <details>
      <summary>Import from files or folder</summary>
      {[false, true].map((folder) => (
        <label key={String(folder)}>
          {folder ? 'Choose folder' : 'Choose files'}
          <input
            type="file"
            multiple
            {...(folder ? { webkitdirectory: '' } : {})}
            accept=".txt,.md,.html,.htm,.eml,.pdf,.docx"
            onChange={(e) =>
              setFiles(
                Array.from(e.target.files ?? []).filter((f) =>
                  /\.(txt|md|html?|eml|docx|pdf)$/i.test(f.name)
                )
              )
            }
          />
        </label>
      ))}
      {files.map((f, i) => (
        <button
          key={i}
          onClick={async () => {
            try {
              const { readApplicationFile } = await import('./importFile.ts')
              const text = await readApplicationFile(f)
              setRaw(text)
              parse(text, f.name)
            } catch (e) {
              setMsg(explain(e))
            }
          }}
        >
          {f.name}
        </button>
      ))}
    </details>
  </>
  return (
    <>
      <div className="study-tools" hidden={helper && edit}>
        <button
          ref={startCapture}
          onClick={() => {
            if (native) { void readForm(); return }
            setEntry(blankApplication())
            setRaw('')
            setEdit(true)
            setMsg('')
          }}
        >
          Capture application
        </button>
        <input
          aria-label="Find my past answers"
          placeholder="Find my past answers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {helper && !edit && !state.applications.length && <p className="enki-hint">Capture a form to keep its questions and your answers together.</p>}
      {helper && !edit && !!state.applications.length && !!q && !matches.length && <p className="enki-hint">No saved answers match this search.</p>}
      {edit && (
        <section className="study-edit">
          {!helper && appendTo}
          {native && (
            <div className="study-tools">
              {!native.activeTab && <select aria-label="Capture source" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="dia">Active Dia tab</option>
                <option value="browser">Worldview browser</option>
              </select>}
              <button
                disabled={reading || openingForm || saving}
                onClick={() => void readForm()}
              >
                {reading ? 'Reading…' : 'Refresh from page'}
              </button>
              {!helper && captureScreen}
            </div>
          )}
          {helper && source === 'browser' && native?.openBrowser && <form className="enki-address enki-form-address" onSubmit={async event => {
            event.preventDefault()
            const address = formUrl.trim()
            if (!address || openingForm || !native.openBrowser) return
            setOpeningForm(true)
            setMsg('Opening form…')
            try {
              await native.openBrowser(address)
              setMsg('Form opened. Choose Read this form when ready.')
            } catch (e) { setMsg(explain(e)) }
            finally { setOpeningForm(false) }
          }}>
            <label className="enki-field">Form URL
              <input type="url" name="formUrl" value={formUrl} required autoComplete="off" spellCheck={false}
                placeholder="Paste a form URL…" onChange={event => setFormUrl(event.target.value)} />
            </label>
            <button disabled={openingForm || reading || saving}>{openingForm ? 'Opening…' : 'Open form'}</button>
          </form>}
          {!helper && imports}
          <div className="study-fields">
            {(helper ? ['opportunity', 'organization'] as const : ['organization', 'opportunity', 'step', 'source'] as const).map(field)}
          </div>
          <div className="application-facts" aria-label="Application details">
            <label>Deadline<input name="deadline" value={entry.deadline || ''} placeholder="Not published" onChange={event=>patch({deadline:event.target.value})} /></label>
            <div><span>Applied</span><strong>{entry.appliedAt ? new Date(entry.appliedAt).toLocaleString() : entry.submitted ? 'Submitted · date not available' : 'No submission observed'}</strong></div>
            {entry.deadlineEvidence && <p>{entry.deadlineEvidence}{entry.deadlineSource && <> <a href={entry.deadlineSource} target="_blank" rel="noreferrer">Source</a></>}</p>}
            {entry.deadline && !/\b20\d{2}\b/.test(entry.deadline) && <small>The published deadline does not specify a year.</small>}
            {entry.description && <p>{entry.description}</p>}
            {entry.organizationId && <p>Matched to a saved organization in your CRM.</p>}
          </div>
          {helper && <details className="enki-step-details"><summary>Step and source</summary>{appendTo}<div className="study-fields">{(['step','source'] as const).map(field)}</div></details>}
          <details className="application-answer-review" open={!helper || undefined}><summary>{entry.answers.length} {entry.answers.length===1 ? 'question' : 'questions'} · {entry.answers.filter(row=>row.answer.trim()).length} answers captured</summary>
          {entry.answers.map((v, i) => (
            <div className="study-pair" key={i}>
              <label>
                Question
                <input
                  value={v.question}
                  onChange={(e) =>
                    patch({
                      answers: entry.answers.map((a, j) => (j === i ? { ...a, question: e.target.value } : a))
                    })
                  }
                />
              </label>
              <label>
                Your answer
                <textarea
                  rows={3}
                  value={v.answer}
                  onChange={(e) =>
                    patch({
                      answers: entry.answers.map((a, j) => (j === i ? { ...a, answer: e.target.value } : a))
                    })
                  }
                />
              </label>
              <button onClick={() => patch({ answers: entry.answers.filter((_, j) => i !== j) })}>
                Remove pair
              </button>
            </div>
          ))}
          <button onClick={() => patch({ answers: [...entry.answers, { question: '', answer: '' }] })}>
            Add question
          </button>
          </details>
          <label>
            <input
              type="checkbox"
              checked={entry.submitted}
              onChange={(e) => patch({ submitted: e.target.checked })}
            />
            Submitted
          </label>
          {helper && <details className="enki-import-tools"><summary>Paste or import material</summary>
            <div>{captureScreen}{imports}</div>
          </details>}
          <div className="study-edit-actions">
          <button
            className="enki-save-application"
            disabled={
              saving || reading ||
              !entry.opportunity.trim() ||
              !entry.step.trim() ||
              entry.answers.some((a) => !a.question.trim())
            }
            onClick={async () => {
              setSaving(true)
              try {
                const saved = await study<{id:string;workspaceToken?:string}>('application', entry)
                await native?.saved?.(saved.id, { ...entry, workspaceToken:saved.workspaceToken ?? entry.workspaceToken })
                setEdit(false)
                refresh()
                setMsg('Application saved')
              } catch (e) {
                setMsg(explain(e))
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? 'Saving…' : 'Save application'}
          </button>
          <button disabled={saving || reading} onClick={() => setEdit(false)}>{helper ? 'Cancel' : 'Close editor'}</button>
          {helper && <span role="status" className="enki-application-status">{msg}</span>}
          </div>
        </section>
      )}
      {!(helper && edit) && <p role="status">{msg}</p>}
      {!(helper && edit) && !q &&
        state.applications
          .filter((a) => !focused || a.id === focused)
          .map((a) => (
            <details key={a.id} open={focused === a.id || undefined}>
              <summary>
                {a.opportunity}{a.organization && a.organization!==a.opportunity ? ' · '+a.organization : ''}{a.deadline ? ' · Due ' + a.deadline : ''}{applicationAppliedAt(a) ? ' · Applied ' + new Date(applicationAppliedAt(a)!).toLocaleDateString() : ''}
              </summary>
              {a.revisions.map((r) => (
                <p key={r.id}>
                  {r.step} · {r.submitted ? 'Submitted' : 'Draft'} · {new Date(r.at).toLocaleString()} ·{' '}
                  {r.answers.length} questions{' '}
                  {/^https?:\/\//.test(r.source) ? (
                    <a href={r.source} target="_blank" rel="noreferrer">
                      Open source
                    </a>
                  ) : (
                    r.source
                  )}{' '}
                  {r.evidence && <span className="study-evidence">{r.evidence}</span>}
                </p>
              ))}
            </details>
          ))}
      {!(helper && edit) && matches.map((v) => (
          <article className="study-answer" key={v.key}>
            <small>
              {v.application.opportunity} · {v.application.organization} ·{' '}
              {new Date(v.revision.at).toLocaleDateString()}
            </small>
            <h3>{v.question}</h3>
            <p>{v.answer || 'Unanswered'}</p>
            {v.answer && (
              <>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(v.answer)
                      setMsg('Answer copied')
                    } catch {
                      setMsg('Select the answer to copy it.')
                    }
                  }}
                >
                  Copy original
                </button>
                {adapt && (
                  <button
                    onClick={() =>
                      void adapt(v.answer, v.question, v.application.id).catch((e) => setMsg(explain(e)))
                    }
                  >
                    Adapt in Writing Studio
                  </button>
                )}
              </>
            )}
          </article>
        ))}
    </>
  )
}
export interface StudyNative {
  form: (mode: string) => Promise<Pick<ApplicationInput, 'organization' | 'opportunity' | 'source' | 'answers'> & Partial<ApplicationInput> & { embeddedForms?: {url:string;title:string}[]; pageText?:string }>
  saved?: (id:string,entry:ApplicationInput) => Promise<void>
  ocr?: () => Promise<string>
  activeTab?: boolean
  openBrowser?: (url: string) => Promise<void>
}
export function StudyDesk({
  mode,
  native,
  adapt,
  initialQuery,
  helper = false,
}: {
  helper?: boolean
  initialQuery?: string
  mode: 'word' | 'application'
  native?: StudyNative
  adapt?: Parameters<typeof Applications>[0]['adapt']
}) {
  const [state, setState] = useState<StudyState>({ schemaVersion: 1, revision: 0, words: [], applications: [] }),
    [error, setError] = useState('')
  const refresh = useCallback(() => {
    void study<StudyState>('state')
      .then((s) => {
        setState(s)
        setError('')
      })
      .catch((e) => setError(explain(e)))
  }, [])
  useEffect(() => {
    let stopped = false,
      unsub: (() => void) | undefined
    refresh()
    void import('../data/repo.ts').then(({ subscribeRepo }) => {
      if (!stopped)
        unsub = subscribeRepo((e) => {
          if (e.type === 'kv' && e.keys.includes('study.v1')) refresh()
        })
    })
    window.addEventListener('focus', refresh)
    return () => {
      stopped = true
      unsub?.()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])
  return (
    <section className="study-desk">
      {error && <p role="alert">{error}</p>}
      {mode === 'word' ? (
        <Vocabulary state={state} refresh={refresh} />
      ) : (
        <Applications initialQuery={initialQuery} state={state} refresh={refresh} native={native} adapt={adapt} helper={helper} />
      )}
    </section>
  )
}
