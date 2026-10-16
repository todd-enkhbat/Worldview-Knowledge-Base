import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { formatByPrecision, yOf, yearsSince } from '../domain/time.ts'
import { minT0 } from '../domain/validate.ts'
import type { ArchiveProgress } from '../data/archive.ts'
import { completeFirstRun, importWorld, useRepoStatus } from '../data/repo.ts'
import { isStandalone, requestPersistence } from '../data/storage.ts'
import {
  INSTALL_TEXT,
  STORAGE_LABEL,
  errorText,
  formatBytes,
  formatDay,
  installHint,
  parseDateInput,
  percent,
  storageKind,
  t0Problem,
} from './durability.ts'
import type { DateInputPrecision } from './durability.ts'
import { BTN, BTN_PRIMARY, Overlay, trapKeys, useInstallPrompt } from './DurabilityKit.tsx'

type Step = 0 | 1 | 2 | 3
type Start = 'empty' | 'demo' | 'import'
type OriginKind = 'birth' | 'worldview'

const STEPS = 4
const HEADLINE = 'm-0 font-sans font-semibold uppercase leading-[0.92] tracking-[-0.02em] text-bone text-[clamp(2.25rem,7vw,6rem)] outline-none'
const CARD = `block cursor-pointer border border-bone/25 p-4 sm:p-5 hover:border-bone/60 has-[:checked]:border-signal has-[:checked]:bg-bone/5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal`
const BIG_PRIMARY = `${BTN_PRIMARY} px-5 py-3 text-[12px]`
const BIG = `${BTN} px-5 py-3 text-[12px]`

function Card({ name, value, checked, onChange, title, children }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; children: ReactNode }) {
  return (
    <label className={CARD}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="sr-only" />
      <span className="block font-mono text-[13px] font-bold uppercase tracking-[0.18em] text-bone">{title}</span>
      <span className="mt-2 block font-mono text-[12px] leading-relaxed text-bone/70">{children}</span>
    </label>
  )
}

function FirstRunFlow() {
  const writer = useRepoStatus((s) => s.writer)
  const fallback = useRepoStatus((s) => s.fallback)
  const storage = useWorld((s) => s.storage)
  const install = useInstallPrompt()
  const [now] = useState(() => Date.now())

  const [step, setStep] = useState<Step>(0)
  const [kind, setKind] = useState<OriginKind>('birth')
  const [text, setText] = useState('')
  const [t0Error, setT0Error] = useState<string | null>(null)
  const [t0, setT0] = useState<{ epochMs: number; precision: DateInputPrecision } | null>(null)
  const [start, setStart] = useState<Start>('empty')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ArchiveProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const hintId = useId()
  const errorId = useId()

  // A wipe (Settings, __wv.wipe or another tab) lands here with the old world's UI state
  // still in useApp: an open editor or modal, a selection, Undo toasts for records that no
  // longer exist. Drop it so none of it resurfaces over the new world once this completes.
  useEffect(() => {
    useApp.setState((s) => ({
      selectedId: null,
      hoveredId: null,
      focusedId: null,
      panels: { ...s.panels, inspector: false, palette: false, settings: false, trash: false, picker: false, demons: false },
      editor: { open: false, nodeId: null, archetype: null },
      toasts: [],
    }))
  }, [])

  // One question per screen: move focus to the new question (the date field on step 1).
  useEffect(() => {
    ;(step === 0 ? inputRef.current : headingRef.current)?.focus()
  }, [step])

  const parsed = parseDateInput(text)
  const back = step > 0 && !busy ? () => setStep((s) => (s - 1) as Step) : null

  const submitT0 = (e: FormEvent) => {
    e.preventDefault()
    if (!parsed.ok) {
      setT0Error(parsed.message)
      return
    }
    const problem = t0Problem(parsed.epochMs, now)
    if (problem) {
      setT0Error(problem)
      return
    }
    setT0Error(null)
    setT0({ epochMs: parsed.epochMs, precision: parsed.precision })
    setStep(1)
  }

  const submitStart = (e: FormEvent) => {
    e.preventDefault()
    if (start === 'import' && !file) {
      fileRef.current?.click()
      return
    }
    setStep(2)
  }

  const submitExplainer = (e: FormEvent) => {
    e.preventDefault()
    setStep(3)
    // From the click, so Firefox may show its permission prompt; Chrome and Safari answer silently.
    requestPersistence()
      .then((p) => useWorld.getState().setStorage({ persisted: p }))
      .catch(() => {})
  }

  const finish = async (e: FormEvent) => {
    e.preventDefault()
    if (t0 === null) return
    setBusy(true)
    setError(null)
    try {
      if (start === 'import' && file) {
        const w = useWorld.getState()
        // Nothing to lose yet, so a browser without a backup target must not block the restore.
        const empty = w.nodes.size === 0 && w.trash.size === 0
        await importWorld(file, { allowWithoutBackup: empty, onProgress: setProgress })
        // An archive normally carries finished settings (its own T0); this unmounts us.
        if (!useWorld.getState().settings?.firstRunComplete) await completeFirstRun({ T0: t0.epochMs, start: 'empty' })
      } else {
        await completeFirstRun({ T0: t0.epochMs, start: start === 'demo' ? 'demo' : 'empty' })
      }
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
      setProgress(null)
    }
  }

  const hint = installHint(typeof navigator === 'undefined' ? '' : navigator.userAgent, isStandalone(), install.canPrompt)
  const kindLabel = kind === 'birth' ? 'birth date' : 'worldview start'
  const t0Label = t0 ? formatByPrecision(t0.epochMs, t0.precision) : ''
  const pc = progress ? percent(progress.done, progress.total) : null

  let body: ReactNode
  if (step === 0) {
    const preview = parsed.ok && !t0Problem(parsed.epochMs, now) ? parsed : null
    body = (
      <form onSubmit={submitT0} noValidate className="space-y-8">
        <h1 id={headingId} ref={headingRef} tabIndex={-1} className={HEADLINE}>
          When does your worldview begin?
        </h1>
        <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
          <legend className="hud-label mb-2">The worldline starts at</legend>
          {(
            [
              ['birth', 'My birth date'],
              ['worldview', 'When my worldview started'],
            ] as const
          ).map(([v, label]) => (
            <label
              key={v}
              className={`cursor-pointer border border-bone/25 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-bone/80 hover:border-bone/60 has-[:checked]:border-signal has-[:checked]:text-bone has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal`}
            >
              <input type="radio" name="origin-kind" value={v} checked={kind === v} onChange={() => setKind(v)} className="sr-only" />
              {label}
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor={`${headingId}-date`} className="hud-label mb-2 block">
            {kind === 'birth' ? 'Born' : 'Started'} · YYYY, YYYY-MM or YYYY-MM-DD
          </label>
          <input
            id={`${headingId}-date`}
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setT0Error(null)
            }}
            placeholder="YYYY-MM-DD"
            inputMode="numeric"
            autoComplete={kind === 'birth' ? 'bday' : 'off'}
            spellCheck={false}
            aria-invalid={t0Error !== null}
            aria-describedby={`${hintId}${t0Error ? ` ${errorId}` : ''}`}
            className="w-[11ch] max-w-full border-0 border-b-2 border-bone/40 bg-transparent px-0 pb-1 font-mono text-[clamp(2rem,6vw,4.5rem)] leading-none text-bone placeholder:text-bone/15 focus:border-signal focus:outline-none"
          />
          <p id={hintId} className="m-0 mt-3 max-w-xl font-mono text-[12px] leading-relaxed text-concrete">
            Everything you add is placed on a worldline rising from this date: one year is 12 units of height. A year on its own is fine. The
            earliest allowed start is {formatDay(minT0(now))}.
          </p>
          {preview && (
            <p className="m-0 mt-2 font-mono text-[12px] text-glass">
              {formatByPrecision(preview.epochMs, preview.precision)} · {Math.floor(yearsSince(now, preview.epochMs))} years ·{' '}
              {Math.round(yOf(now, preview.epochMs))} u of worldline so far
            </p>
          )}
          {t0Error && (
            <p id={errorId} role="alert" className="m-0 mt-2 font-mono text-[12px] text-signal">
              {t0Error}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button type="submit" className={BIG_PRIMARY} disabled={text.trim() === ''}>
            Continue
          </button>
        </div>
      </form>
    )
  } else if (step === 1) {
    body = (
      <form onSubmit={submitStart} className="space-y-8">
        <h1 id={headingId} ref={headingRef} tabIndex={-1} className={HEADLINE}>
          What should it start with?
        </h1>
        <fieldset className="m-0 grid max-w-4xl gap-3 border-0 p-0 sm:grid-cols-3">
          <legend className="sr-only">Starting content</legend>
          <Card name="start" value="empty" checked={start === 'empty'} onChange={() => setStart('empty')} title="Empty">
            A bare worldline. Place your first idea yourself.
          </Card>
          <Card name="start" value="demo" checked={start === 'demo'} onChange={() => setStart('demo')} title="Demo">
            About 30 example ideas, people and memories, dated against your start. Delete them any time.
          </Card>
          <Card name="start" value="import" checked={start === 'import'} onChange={() => setStart('import')} title="Import">
            Restore an archive you exported earlier. Its own start date replaces the one you entered.
          </Card>
        </fieldset>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0] ?? null
            e.currentTarget.value = ''
            if (f) {
              setFile(f)
              setStart('import')
            }
          }}
        />
        {start === 'import' && (
          <div className="flex flex-wrap items-center gap-4 font-mono text-[12px]">
            <button type="button" className={BTN} onClick={() => fileRef.current?.click()}>
              {file ? 'Choose another archive' : 'Choose archive…'}
            </button>
            {file && (
              <span className="text-bone">
                {file.name} <span className="text-concrete">· {formatBytes(file.size)}</span>
              </span>
            )}
          </div>
        )}
        <div className="flex gap-3">
          <button type="button" className={BIG} onClick={() => setStep(0)}>
            Back
          </button>
          <button type="submit" className={BIG_PRIMARY}>
            {start === 'import' && !file ? 'Choose archive' : 'Continue'}
          </button>
        </div>
      </form>
    )
  } else if (step === 2) {
    const points: ReactNode[] = [
      <>
        Everything stays in this browser, at <code className="text-bone">{storage.origin || 'this address'}</code>. No account, no server, no sync. Another
        browser or port sees a different, empty world.
      </>,
      <>Browsers may delete site storage: when the disk runs low, or in Safari after 7 days without a visit.</>,
      <>Export backups. One .zip holds the whole world: Settings → Backups. You will be reminded after 3 days without one.</>,
      <>{INSTALL_TEXT[hint]}</>,
    ]
    body = (
      <form onSubmit={submitExplainer} className="space-y-8">
        <h1 id={headingId} ref={headingRef} tabIndex={-1} className={HEADLINE}>
          Your world lives here, and only here.
        </h1>
        <ol className="m-0 max-w-2xl list-none space-y-4 p-0 font-mono text-[13px] leading-relaxed text-bone/85">
          {points.map((p, i) => (
            <li key={i} className="grid grid-cols-[2.5rem_1fr] border-t border-bone/15 pt-3">
              <span className="text-concrete">{String(i + 1).padStart(2, '0')}</span>
              <span>{p}</span>
            </li>
          ))}
        </ol>
        {fallback && (
          <p role="alert" className="m-0 max-w-2xl border-l-2 border-signal pl-3 font-mono text-[12px] text-signal">
            Storage is unavailable in this window (private browsing?). Nothing will be saved after this tab closes.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="button" className={BIG} onClick={() => setStep(1)}>
            Back
          </button>
          {hint === 'prompt' && (
            <button type="button" className={BIG} onClick={() => void install.prompt()}>
              Install app
            </button>
          )}
          <button type="submit" className={BIG_PRIMARY}>
            Understood
          </button>
        </div>
      </form>
    )
  } else {
    const kindNow = storageKind({ fallback, persisted: storage.persisted })
    body = (
      <form onSubmit={finish} className="space-y-8">
        <h1 id={headingId} ref={headingRef} tabIndex={-1} className={HEADLINE}>
          Ready.
        </h1>
        <dl className="m-0 grid max-w-2xl grid-cols-[8rem_1fr] gap-y-3 font-mono text-[13px]">
          <dt className="hud-label pt-0.5">Begins</dt>
          <dd className="m-0 text-bone">
            {start === 'import' ? `the archive’s own start date (you entered ${t0Label})` : `${t0Label} · ${kindLabel}`}
          </dd>
          <dt className="hud-label pt-0.5">With</dt>
          <dd className="m-0 text-bone">{start === 'empty' ? 'nothing yet' : start === 'demo' ? 'the demo world' : (file?.name ?? 'an archive')}</dd>
          <dt className="hud-label pt-0.5">Storage</dt>
          <dd className="m-0 text-bone">{STORAGE_LABEL[kindNow]}</dd>
        </dl>
        {!writer && (
          <p role="alert" className="m-0 max-w-2xl border-l-2 border-ember pl-3 font-mono text-[12px] text-ember">
            Another tab has this world open for editing. Finish the setup there, or close it and this tab takes over.
          </p>
        )}
        <div aria-live="polite" className="font-mono text-[12px]">
          {error && (
            <p role="alert" className="m-0 max-w-2xl text-signal">
              {error}
            </p>
          )}
          {busy && <p className="m-0 text-concrete">{progress ? `${progress.phase}${pc === null ? '' : ` ${pc}%`}` : start === 'demo' ? 'Building the demo world…' : 'Setting up…'}</p>}
        </div>
        <div className="flex gap-3">
          <button type="button" className={BIG} onClick={() => setStep(2)} disabled={busy}>
            Back
          </button>
          <button type="submit" className={BIG_PRIMARY} disabled={busy || !writer} aria-busy={busy}>
            {busy ? 'Working…' : 'Enter the world'}
          </button>
        </div>
      </form>
    )
  }

  return (
    <Overlay>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(e) => trapKeys(e, rootRef.current, back)}
        className="fixed inset-0 z-[60] overflow-y-auto bg-void text-bone"
      >
        <div className="mx-auto flex min-h-full max-w-6xl flex-col px-6 py-6 sm:px-12 sm:py-10">
          <header className="flex items-center justify-between font-mono">
            <span className="hud-label">Architectural Hyperspace · first run</span>
            <span className="hud-label" aria-label={`Step ${step + 1} of ${STEPS}`}>
              {String(step + 1).padStart(2, '0')} / {String(STEPS).padStart(2, '0')}
            </span>
          </header>
          <div className="mt-3 grid grid-cols-4 gap-1" aria-hidden="true">
            {Array.from({ length: STEPS }, (_, i) => (
              <span key={i} className={`h-0.5 ${i <= step ? 'bg-signal' : 'bg-bone/15'}`} />
            ))}
          </div>
          <div className="flex flex-1 flex-col justify-center py-12 sm:py-20">{body}</div>
          <footer className="font-mono text-[10px] uppercase tracking-[0.14em] text-concrete">
            {step > 0 ? 'Esc · back' : 'Enter · continue'}
          </footer>
        </div>
      </div>
    </Overlay>
  )
}

/**
 * Full-screen first run: shown once the repo is ready and there are no finished settings
 * (a fresh profile, or right after "Wipe world"). Completing it creates the settings, which
 * unmounts it.
 */
export function FirstRun() {
  const ready = useRepoStatus((s) => s.ready)
  const settings = useWorld((s) => s.settings)
  if (!ready || settings?.firstRunComplete) return null
  return <FirstRunFlow />
}
