import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { formatByPrecision } from '../domain/time.ts'
import type { QualityTier } from '../domain/types.ts'
import { ArchiveError } from '../data/archive.ts'
import type { ArchiveProgress, ImportResult } from '../data/archive.ts'
import {
  autoBackupSupported,
  backupFolderPermission,
  chooseBackupFolder,
  forgetBackupFolder,
  getBackupFolder,
  regrantBackupFolder,
  shouldNag,
} from '../data/autoBackup.ts'
import type { AutoBackupOutcome, FolderPermission } from '../data/autoBackup.ts'
import { readAnyBackup } from '../data/backupTargets.ts'
import { backupNow, getStore, importWorld, isRepoReady, relayoutWorld, updateSettings, useRepoStatus, wipeWorld } from '../data/repo.ts'
import type { RelayoutResult } from '../data/repo.ts'
import { initStorageStatus, isStandalone, requestPersistence, safariEvictionRisk } from '../data/storage.ts'
import { Credits } from './Credits.tsx'
import { getEnginePreference, migrateWorld, planMigration, probeEngine, type EngineHealth, type EngineKind, type MigrationPlan } from '../data/engine.ts'
import { disableSemantic, enableSemantic, useSemantic } from '../ai/semanticIndex.ts'
import { runRecrystallise } from '../ai/recrystallise.ts'
import {
  INSTALL_TEXT,
  STORAGE_EXPLAIN,
  STORAGE_LABEL,
  WIPE_PHRASE,
  backupAgeLabel,
  errorText,
  formatBytes,
  formatDay,
  installHint,
  parseDateInput,
  percent,
  plural,
  storageKind,
  usageFraction,
  wipeConfirmed,
} from './durability.ts'
import { BTN, BTN_DANGER, BTN_PRIMARY, ConfirmDialog, FOCUS, HudDialog, saveWorldArchive, useInstallPrompt, useNow } from './DurabilityKit.tsx'

const INPUT = `border border-bone/30 bg-transparent px-2 py-1 font-mono text-[12px] text-bone placeholder:text-concrete/60 ${FOCUS}`

const TIERS: readonly { value: QualityTier; label: string }[] = [
  { value: 'auto', label: 'Auto — adapt to the frame rate' },
  { value: 'high', label: 'High — full reflections, bloom, splat detail' },
  { value: 'medium', label: 'Medium — half-resolution reflections' },
  { value: 'low', label: 'Low — no reflections, fewer splats' },
]

// ─── layout ────────────────────────────────────────────────────────────────────────

function Section({ title, intro, children, danger = false }: { title: string; intro?: ReactNode; children: ReactNode; danger?: boolean }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={`grid gap-x-8 gap-y-3 border-b px-5 py-6 sm:grid-cols-[10.5rem_1fr] ${danger ? 'border-signal/40' : 'border-bone/10'}`}>
      <div>
        <h3 id={id} className={`hud-label m-0 ${danger ? 'text-signal' : ''}`}>
          {title}
        </h3>
        {intro && <p className="m-0 mt-2 text-[11px] leading-relaxed text-concrete">{intro}</p>}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  )
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="hud-label w-20 shrink-0 pt-px">{k}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  )
}

function Note({ tone = 'plain', children }: { tone?: 'plain' | 'warn' | 'alarm' | 'ok'; children: ReactNode }) {
  const color = tone === 'alarm' ? 'border-signal text-signal' : tone === 'warn' ? 'border-ember text-ember' : tone === 'ok' ? 'border-glass text-glass' : 'border-bone/30 text-bone/80'
  return <p className={`m-0 border-l-2 pl-3 leading-relaxed ${color}`}>{children}</p>
}

/** Inline result line for an action: announced politely, errors as alerts. */
function Outcome({ ok, error }: { ok: string | null; error: string | null }) {
  return (
    <div aria-live="polite">
      {error ? (
        <p role="alert" className="m-0 text-signal">
          {error}
        </p>
      ) : ok ? (
        <p className="m-0 text-glass">{ok}</p>
      ) : null}
    </div>
  )
}

function progressText(p: ArchiveProgress | null): string | null {
  if (!p || p.phase === 'done') return null
  const pc = percent(p.done, p.total)
  return `${p.phase}${pc === null ? '' : ` ${pc}%`}`
}

// ─── storage ───────────────────────────────────────────────────────────────────────

const KIND_TONE = { persisted: 'text-glass', 'best-effort': 'text-ember', memory: 'text-signal', unknown: 'text-concrete' } as const

function StorageSection() {
  const storage = useWorld((s) => s.storage)
  const fallback = useRepoStatus((s) => s.fallback)
  const kind = storageKind({ fallback, persisted: storage.persisted })
  const install = useInstallPrompt()
  const hint = installHint(typeof navigator === 'undefined' ? '' : navigator.userAgent, isStandalone(), install.canPrompt)
  const frac = usageFraction(storage.usage, storage.quota)
  const [msg, setMsg] = useState<{ ok: string | null; error: string | null }>({ ok: null, error: null })

  // Re-probe on open (usage changes as the world grows). Never prompts: requestPersist false.
  useEffect(() => {
    initStorageStatus({ requestPersist: false }).catch(() => {})
  }, [])

  const askPersist = async () => {
    const r = await requestPersistence()
    useWorld.getState().setStorage({ persisted: r })
    setMsg(
      r === true
        ? { ok: 'Storage is now persisted.', error: null }
        : { ok: null, error: r === false ? 'The browser declined. Installing the app (or using it more) usually earns durable storage.' : 'This browser has no persistence API.' },
    )
  }

  const onInstall = async () => {
    const outcome = await install.prompt()
    if (outcome === 'accepted') setMsg({ ok: 'Installed. Open the app window from now on: it uses this same storage.', error: null })
  }

  return (
    <Section title="Storage" intro="Everything lives in this browser. There is no server and no sync.">
      <KV k="Status">
        <span className={`font-bold tracking-[0.14em] ${KIND_TONE[kind]}`}>{STORAGE_LABEL[kind]}</span>
        <span className="block text-bone/75">{STORAGE_EXPLAIN[kind]}</span>
      </KV>
      <KV k="Origin">
        <code className="text-bone">{storage.origin || '—'}</code>
        <span className="block text-bone/75">Another browser, profile or port sees a different, empty world. Move worlds with export and import.</span>
      </KV>
      <KV k="Used">
        {formatBytes(storage.usage)} of {formatBytes(storage.quota)}
        {frac !== null && (
          <span className="mt-1.5 block h-1 w-full max-w-xs bg-bone/10" role="img" aria-label={`${Math.round(frac * 100)}% of quota used`}>
            <span className={`block h-full ${frac > 0.8 ? 'bg-signal' : 'bg-bone/60'}`} style={{ width: `${Math.max(1, frac * 100)}%` }} />
          </span>
        )}
      </KV>
      {storage.privateMode === true && (
        <Note tone="alarm">This looks like a private window. Its storage is deleted when the window closes: export before you leave.</Note>
      )}
      {safariEvictionRisk() && (
        <Note tone="warn">Safari deletes the storage of sites you have not opened for 7 days. Install the app (File → Add to Dock) or export regularly.</Note>
      )}
      <Note>{INSTALL_TEXT[hint]}</Note>
      <div className="flex flex-wrap gap-2">
        {hint === 'prompt' && (
          <button type="button" className={BTN} onClick={onInstall}>
            Install app
          </button>
        )}
        {!fallback && kind !== 'persisted' && (
          <button type="button" className={BTN} onClick={askPersist}>
            Ask for durable storage
          </button>
        )}
      </div>
      <Outcome {...msg} />
    </Section>
  )
}

// ─── backups ───────────────────────────────────────────────────────────────────────

function outcomeText(o: AutoBackupOutcome | null): string {
  if (!o) return 'Automatic backups are not running in this tab.'
  if (o.status === 'written') return `Backed up: ${o.name} (${formatBytes(o.bytes)}).`
  switch (o.reason) {
    case 'disabled':
      return 'Automatic backups are off.'
    case 'no-settings':
      return 'Nothing to back up yet.'
    case 'no-folder':
      return 'Choose a folder first.'
    case 'needs-regrant':
      return 'The browser needs permission to the folder again.'
  }
}

function AutoBackup({ canWrite }: { canWrite: boolean }) {
  const settings = useWorld((s) => s.settings)
  const backupError = useRepoStatus((s) => s.backupError)
  const [folder, setFolder] = useState<{ name: string; permission: FolderPermission } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: string | null; error: string | null }>({ ok: null, error: null })

  const refresh = useCallback(async () => {
    if (!isRepoReady()) return
    const store = getStore()
    const dir = await getBackupFolder(store)
    setFolder(dir ? { name: dir.name, permission: await backupFolderPermission(store) } : null)
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  const act = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key)
    setMsg({ ok: null, error: null })
    try {
      const ok = await fn()
      setMsg({ ok, error: null })
    } catch (e) {
      setMsg({ ok: null, error: errorText(e) })
    } finally {
      setBusy(null)
      await refresh().catch(() => {})
    }
  }

  const enableAndRun = async (): Promise<string> => {
    if (!useWorld.getState().settings?.autoBackupEnabled) await updateSettings({ autoBackupEnabled: true })
    return outcomeText(await backupNow())
  }

  // The pickers and permission prompts need the click's user activation: call them first.
  const choose = () =>
    act('choose', async () => {
      const dir = await chooseBackupFolder(getStore())
      if (!dir) return null
      return enableAndRun()
    })
  const regrant = () =>
    act('regrant', async () => {
      if (!(await regrantBackupFolder(getStore()))) throw new Error('Folder access was not granted.')
      return enableAndRun()
    })

  if (!autoBackupSupported()) {
    return <Note>Automatic folder backups need Chrome or Edge. In this browser, export by hand.</Note>
  }
  const on = settings?.autoBackupEnabled === true
  const granted = folder?.permission === 'granted'
  return (
    <div className="space-y-3">
      <div className="hud-label">Automatic backups</div>
      <p className="m-0 leading-relaxed text-bone/75">
        A rolling backup to a folder on your disk, a minute after you stop editing. The newest 5 are kept.
      </p>
      {folder ? (
        <KV k="Folder">
          <span className="text-bone">{folder.name}</span> · {on ? (granted ? <span className="text-glass">on</span> : <span className="text-ember">paused: needs access</span>) : 'off'}
        </KV>
      ) : (
        <KV k="Folder">none</KV>
      )}
      {backupError && <Note tone="alarm">Last automatic backup failed: {backupError}</Note>}
      <div className="flex flex-wrap gap-2">
        {!folder && (
          <button type="button" className={BTN} onClick={choose} disabled={!canWrite || busy !== null}>
            {busy === 'choose' ? 'Choosing…' : 'Choose folder'}
          </button>
        )}
        {folder && !granted && (
          <button type="button" className={BTN} onClick={regrant} disabled={!canWrite || busy !== null}>
            {busy === 'regrant' ? 'Asking…' : 'Allow access again'}
          </button>
        )}
        {folder && granted && !on && (
          <button type="button" className={BTN} onClick={() => act('on', enableAndRun)} disabled={!canWrite || busy !== null}>
            Turn on
          </button>
        )}
        {folder && granted && on && (
          <button type="button" className={BTN} onClick={() => act('now', async () => outcomeText(await backupNow()))} disabled={!canWrite || busy !== null}>
            {busy === 'now' ? 'Backing up…' : 'Back up now'}
          </button>
        )}
        {folder && (
          <button type="button" className={BTN} onClick={choose} disabled={!canWrite || busy !== null}>
            Change folder
          </button>
        )}
        {folder && on && (
          <button
            type="button"
            className={BTN}
            onClick={() =>
              act('off', async () => {
                await updateSettings({ autoBackupEnabled: false })
                return 'Automatic backups are off.'
              })
            }
            disabled={!canWrite || busy !== null}
          >
            Turn off
          </button>
        )}
        {folder && !on && (
          <button
            type="button"
            className={BTN}
            onClick={() =>
              act('forget', async () => {
                await forgetBackupFolder(getStore())
                return 'Folder forgotten. Files already in it are kept.'
              })
            }
            disabled={!canWrite || busy !== null}
          >
            Forget folder
          </button>
        )}
      </div>
      <Outcome {...msg} />
    </div>
  )
}

function BackupsSection({ canWrite }: { canWrite: boolean }) {
  const settings = useWorld((s) => s.settings)
  const now = useNow()
  const [progress, setProgress] = useState<ArchiveProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: string | null; error: string | null }>({ ok: null, error: null })
  const nag = settings !== null && shouldNag(settings, now)

  const onExport = async () => {
    setBusy(true)
    setMsg({ ok: null, error: null })
    try {
      const r = await saveWorldArchive(setProgress)
      if (r.method === 'cancelled') setMsg({ ok: null, error: null })
      else {
        const missing = r.result.missingAssets.length
        setMsg({
          ok: `${r.method === 'picker' ? 'Saved' : 'Downloaded'} ${formatBytes(r.result.bytes)} archive.${missing ? ` ${plural(missing, 'asset')} could not be read and were left out.` : ''}`,
          error: null,
        })
      }
    } catch (e) {
      setMsg({ ok: null, error: errorText(e) })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const p = progressText(progress)
  return (
    <Section title="Backups" intro="Browser storage is the only copy. An export is a single .zip you can keep anywhere and import later.">
      <KV k="Last">
        <span className={nag ? 'text-signal' : 'text-bone'}>{settings ? backupAgeLabel(settings.lastBackupAt, now) : '—'}</span>
        {settings?.lastBackupAt != null && <span className="text-concrete"> · {formatDay(settings.lastBackupAt)}</span>}
        {nag && <span className="block text-bone/75">More than 3 days without a backup.</span>}
      </KV>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN_PRIMARY} onClick={onExport} disabled={busy} aria-busy={busy}>
          {busy ? 'Exporting…' : 'Export now'}
        </button>
        {p && <span className="text-concrete" aria-live="off">{p}</span>}
      </div>
      {!canWrite && <Note tone="warn">Exports from a read-only tab do not reset the backup reminder.</Note>}
      <Outcome {...msg} />
      <div className="border-t border-bone/10 pt-4">
        <AutoBackup canWrite={canWrite} />
      </div>
    </Section>
  )
}

// ─── import ────────────────────────────────────────────────────────────────────────

function ImportSection({ canWrite }: { canWrite: boolean }) {
  const nodeCount = useWorld((s) => s.nodes.size)
  const trashCount = useWorld((s) => s.trash.size)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [noBackup, setNoBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ArchiveProgress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [msg, setMsg] = useState<{ ok: string | null; error: string | null }>({ ok: null, error: null })

  const runImport = async (blob: Blob, allowWithoutBackup: boolean, label: string) => {
    setBusy(true)
    setMsg({ ok: null, error: null })
    try {
      const r = await importWorld(blob, { allowWithoutBackup, onProgress: setProgress })
      setResult(r)
      setNoBackup(false)
      setConfirming(false)
      setMsg({ ok: `${label}: ${plural(r.nodes, 'record')}, ${plural(r.assets, 'asset')}.`, error: null })
    } catch (e) {
      setConfirming(false)
      if (e instanceof ArchiveError && e.code === 'backup-unavailable') setNoBackup(true)
      const restored = e instanceof ArchiveError && e.backupName ? ` Your previous world was restored from ${e.backupName}.` : ''
      setMsg({ ok: null, error: `${errorText(e)}${restored}` })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const restorePrevious = async () => {
    if (!result?.backupName) return
    const blob = await readAnyBackup(result.backupName).catch(() => undefined)
    if (!blob) {
      setMsg({ ok: null, error: 'That pre-import backup is no longer available.' })
      return
    }
    await runImport(blob, false, 'Previous world restored')
    setResult(null)
  }

  const p = progressText(progress)
  return (
    <Section title="Import" intro="Import replaces this world with an archive. It never merges.">
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
          if (!f) return
          setFile(f)
          setNoBackup(false)
          setResult(null)
          setMsg({ ok: null, error: null })
          setConfirming(true)
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} onClick={() => fileRef.current?.click()} disabled={!canWrite || busy}>
          {busy ? 'Importing…' : 'Import archive…'}
        </button>
        {p && <span className="text-concrete">{p}</span>}
      </div>
      {noBackup && file && (
        <div className="space-y-2">
          <Note tone="warn">
            No automatic backup can be taken in this browser, so the import stopped before touching anything. Export now to keep the current world,
            then import without the automatic backup.
          </Note>
          <button type="button" className={BTN_DANGER} onClick={() => runImport(file, true, 'Imported')} disabled={busy}>
            Import without backup
          </button>
        </div>
      )}
      <Outcome {...msg} />
      {result?.backupName && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-concrete">The previous world was kept as {result.backupName}.</span>
          <button type="button" className={BTN} onClick={restorePrevious} disabled={busy}>
            Restore previous world
          </button>
        </div>
      )}
      {confirming && file && (
        <ConfirmDialog
          title="Replace this world"
          confirmLabel="Replace world"
          danger
          busy={busy}
          onConfirm={() => runImport(file, false, 'Imported')}
          onCancel={() => setConfirming(false)}
        >
          <p className="m-0">
            Importing <span className="text-bone">{file.name}</span> ({formatBytes(file.size)}) replaces everything here: {plural(nodeCount, 'record')}
            {trashCount ? ` and ${trashCount} in the trash` : ''}, their attachments and settings.
          </p>
          <p className="m-0">
            First, the current world is saved automatically as a pre-import backup inside this browser (the newest 3 are kept). If the import fails
            partway, that backup is restored. Afterwards you can restore it from here.
          </p>
          {p && <p className="m-0 text-concrete">{p}</p>}
        </ConfirmDialog>
      )}
    </Section>
  )
}

// ─── re-layout ─────────────────────────────────────────────────────────────────────

function RelayoutSection({ canWrite }: { canWrite: boolean }) {
  const settings = useWorld((s) => s.settings)
  const inputId = useId()
  const [text, setText] = useState('')
  const [candidate, setCandidate] = useState<number | null>(null)
  const [preview, setPreview] = useState<RelayoutResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: string | null; error: string | null }>({ ok: null, error: null })
  if (!settings) return null

  const onPreview = async (e: FormEvent) => {
    e.preventDefault()
    setMsg({ ok: null, error: null })
    setPreview(null)
    const parsed = parseDateInput(text)
    if (!parsed.ok) {
      setMsg({ ok: null, error: parsed.message })
      return
    }
    setBusy(true)
    try {
      setCandidate(parsed.epochMs)
      setPreview(await relayoutWorld(parsed.epochMs, { apply: false }))
    } catch (err) {
      setMsg({ ok: null, error: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  const onApply = async () => {
    if (candidate === null) return
    setBusy(true)
    try {
      const r = await relayoutWorld(candidate, { apply: true })
      setPreview(r.applied ? null : r)
      setMsg(r.applied ? { ok: `The world now starts ${formatDay(candidate)}.`, error: null } : { ok: null, error: 'Some records no longer fit. Nothing was changed.' })
      if (r.applied) setText('')
    } catch (err) {
      setMsg({ ok: null, error: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  const editRecord = (id: string) => {
    const app = useApp.getState()
    const rec = useWorld.getState().nodes.get(id)
    app.togglePanel('settings', false)
    app.openEditor({ nodeId: id, archetype: rec?.archetype ?? null })
  }

  const fits = preview !== null && preview.settingsIssues.length === 0 && preview.outOfRange.length === 0
  const same = candidate === settings.T0
  return (
    <Section
      title="Re-layout world"
      intro="T0 is the bottom of the worldline. Changing it moves every record’s height; positions across the floor stay."
    >
      <KV k="T0 now">
        <span className="text-bone">{formatDay(settings.T0)}</span>
      </KV>
      <form onSubmit={onPreview} className="flex flex-wrap items-end gap-2">
        <label htmlFor={inputId} className="flex flex-col gap-1">
          <span className="hud-label">New T0</span>
          <input
            id={inputId}
            className={`${INPUT} w-40`}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setPreview(null)
            }}
            placeholder="YYYY-MM-DD"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            disabled={!canWrite}
          />
        </label>
        <button type="submit" className={BTN} disabled={!canWrite || busy || text.trim() === ''}>
          Preview
        </button>
      </form>
      {preview && (
        <div className="space-y-2" aria-live="polite">
          {preview.settingsIssues.map((i) => (
            <Note key={i.field + i.message} tone="alarm">
              {i.message}
            </Note>
          ))}
          {preview.outOfRange.length > 0 && (
            <>
              <Note tone="warn">
                {plural(preview.outOfRange.length, 'record')} would fall outside the worldline. Nothing is clamped: redate them, or pick an earlier T0.
              </Note>
              <ul className="m-0 max-h-48 list-none overflow-y-auto border border-bone/10 p-0">
                {preview.outOfRange.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 border-b border-bone/10 px-3 py-1.5 last:border-b-0">
                    <span className="w-24 shrink-0 text-concrete">{formatByPrecision(r.temporalOrigin, 'day')}</span>
                    <span className="min-w-0 flex-1 truncate" title={r.issues.map((i) => i.message).join('; ')}>
                      {r.title}
                    </span>
                    <button type="button" className={BTN} onClick={() => editRecord(r.id)}>
                      Edit
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {fits && same && <Note>That is already T0.</Note>}
          {fits && !same && candidate !== null && (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Every record fits. Re-layout from <span className="text-bone">{formatDay(candidate)}</span>?
              </span>
              <button type="button" className={BTN_PRIMARY} onClick={onApply} disabled={busy}>
                {busy ? 'Applying…' : 'Apply re-layout'}
              </button>
            </div>
          )}
        </div>
      )}
      <Outcome {...msg} />
    </Section>
  )
}

// ─── quality ───────────────────────────────────────────────────────────────────────

function QualitySection({ canWrite }: { canWrite: boolean }) {
  const tier = useApp((s) => s.quality.tier)
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const onChange = async (t: QualityTier) => {
    setError(null)
    useApp.getState().setQuality({ tier: t })
    if (!canWrite) return
    try {
      await updateSettings({ qualityTier: t })
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Section title="Quality" intro="Rendering detail. Saved with the world; applies right away.">
      <label htmlFor={id} className="flex flex-col gap-1">
        <span className="hud-label">Tier</span>
        <select id={id} className={`${INPUT} w-full max-w-sm bg-void`} value={tier} onChange={(e) => onChange(e.target.value as QualityTier)}>
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <Outcome ok={null} error={error} />
    </Section>
  )
}

// ─── danger zone ───────────────────────────────────────────────────────────────────

function DangerSection({ canWrite }: { canWrite: boolean }) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = wipeConfirmed(typed)
  const onWipe = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await wipeWorld({ confirm: true })
      // First run takes over from here.
      useApp.getState().togglePanel('settings', false)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Section title="Danger zone" danger intro="Irreversible. Export first if there is anything you may want back.">
      <form onSubmit={onWipe} className="space-y-2">
        <p className="m-0 leading-relaxed">
          Wipe world erases every record, attachment, the trash and the interaction history in this browser, then starts the first run again.
        </p>
        <label htmlFor={id} className="flex flex-col gap-1">
          <span className="hud-label">
            Type <span className="normal-case tracking-normal text-bone">“{WIPE_PHRASE}”</span> to confirm
          </span>
          <input
            id={id}
            className={`${INPUT} w-56`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={!canWrite || busy}
          />
        </label>
        <button type="submit" className={BTN_DANGER} disabled={!canWrite || !ok || busy} aria-busy={busy}>
          {busy ? 'Wiping…' : 'Wipe world'}
        </button>
        <Outcome ok={null} error={error} />
      </form>
    </Section>
  )
}

// ─── panel ─────────────────────────────────────────────────────────────────────────

// ─── engine (Phase 4) ──────────────────────────────────────────────────────────────

function EngineSection({ canWrite }: { canWrite: boolean }) {
  const current = getEnginePreference()
  const target: EngineKind = current === 'sqlite' ? 'idb' : 'sqlite'
  const [health, setHealth] = useState<EngineHealth | null | 'checking'>('checking')
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void probeEngine().then((h) => live && setHealth(h))
    return () => {
      live = false
    }
  }, [])
  const prepare = async () => {
    setError(null)
    setOk(null)
    try {
      setPlan(await planMigration(target))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const run = async () => {
    if (!plan) return
    setBusy(true)
    setError(null)
    try {
      const r = await migrateWorld(getStore(), target, { confirmReplace: plan.targetHasWorld })
      setOk(`Moved ${plural(r.nodes, 'record')} and ${plural(r.assets, 'asset')} to ${target === 'sqlite' ? 'SQLite' : 'IndexedDB'}. Reloading…`)
      setTimeout(() => location.reload(), 900)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    } finally {
      setPlan(null)
    }
  }
  const name = (k: EngineKind) => (k === 'sqlite' ? 'SQLite (local server)' : 'IndexedDB (this browser)')
  return (
    <Section
      title="Engine"
      intro="Where the world is stored. SQLite runs inside the dev server (npm run dev) and adds server-side vector search; IndexedDB works anywhere, including the static build."
    >
      <KV k="Now">{name(current)}</KV>
      <KV k="SQLite">
        {health === 'checking' ? 'checking…' : health ? `running · Claude refinement ${health.refine ? 'on' : 'off (no ANTHROPIC_API_KEY)'}` : 'not running'}
      </KV>
      <Note>
        Moving copies the whole world through an export archive and checks its records hash. The engine you leave keeps its copy untouched, so
        you can always move back.
      </Note>
      {plan ? (
        <div className="space-y-2">
          <Note tone={plan.targetHasWorld ? 'warn' : 'plain'}>
            {plan.targetHasWorld
              ? `${name(target)} already holds a world (${plural(plan.targetNodes, 'record')}). It will be replaced; a pre-import backup of it is kept.`
              : `${name(target)} is empty.`}
          </Note>
          <div className="flex gap-2">
            <button type="button" className={plan.targetHasWorld ? BTN_DANGER : BTN_PRIMARY} disabled={busy} onClick={() => void run()}>
              {busy ? 'Moving…' : `Move to ${target === 'sqlite' ? 'SQLite' : 'IndexedDB'}`}
            </button>
            <button type="button" className={BTN} disabled={busy} onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={BTN} disabled={!canWrite || busy || (target === 'sqlite' && !health)} onClick={() => void prepare()}>
          Move world to {target === 'sqlite' ? 'SQLite' : 'IndexedDB'}…
        </button>
      )}
      <Outcome ok={ok} error={error} />
    </Section>
  )
}

// ─── semantic engine (Phase 4) ─────────────────────────────────────────────────────

function SemanticSection({ canWrite }: { canWrite: boolean }) {
  const sem = useSemantic()
  const [ok, setOk] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const recrystallise = async () => {
    setBusy(true)
    setOk(null)
    setError(null)
    try {
      const r = await runRecrystallise()
      setOk(r.moved ? `Re-crystallised: ${plural(r.moved, 'node')} moved (mean turn ${Math.round((r.meanTurn * 180) / Math.PI)}°). Undo is in the toast.` : 'Already crystallised: nothing moved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Semantic engine"
      intro="EmbeddingGemma 2 runs in this browser (no data leaves it). The first start downloads the model from Hugging Face (about 175 MB with WebGPU, 315 MB without), then it is cached."
    >
      <KV k="Status">
        {sem.phase === 'off' && 'off'}
        {sem.phase === 'loading-model' && `downloading the model ${Math.round(sem.download * 100)}%`}
        {sem.phase === 'indexing' && `indexing ${sem.indexed} / ${sem.total}`}
        {sem.phase === 'ready' && `ready · ${sem.indexed} nodes · ${sem.config ?? ''} · ${sem.backend === 'sqlite' ? 'vectors in SQLite (sqlite-vec)' : 'vectors in this browser'}`}
        {sem.phase === 'error' && <span className="text-signal">{sem.error}</span>}
      </KV>
      <div className="flex flex-wrap gap-2">
        {sem.phase === 'off' || sem.phase === 'error' ? (
          <button type="button" className={BTN_PRIMARY} onClick={() => void enableSemantic().catch((e: unknown) => setError(String(e)))}>
            {sem.phase === 'error' ? 'Retry' : 'Turn on (model download)'}
          </button>
        ) : (
          <button type="button" className={BTN} onClick={() => disableSemantic()}>
            Turn off
          </button>
        )}
        <button type="button" className={BTN} disabled={!canWrite || busy || sem.phase !== 'ready'} onClick={() => void recrystallise()}>
          {busy ? 'Re-crystallising…' : 'Re-crystallise layout'}
        </button>
      </div>
      <Note>
        New nodes land near what they mean. Re-crystallise lays out every node by meaning at once (UMAP, aligned to the current layout so the
        world turns as little as possible); each node keeps its distance from the axis and its date.
      </Note>
      <Outcome ok={ok} error={error} />
    </Section>
  )
}

function SettingsPanel() {
  const writer = useRepoStatus((s) => s.writer)
  const ready = useRepoStatus((s) => s.ready)
  const nodeCount = useWorld((s) => s.nodes.size)
  const trashCount = useWorld((s) => s.trash.size)
  const canWrite = ready && writer
  const app = useApp.getState
  return (
    <HudDialog title="Settings" onClose={() => app().escape()} width="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-bone/10 px-5 py-3 text-concrete">
        <span>
          {plural(nodeCount, 'record')} · {trashCount} in trash
        </span>
        <button
          type="button"
          className={BTN}
          onClick={() => {
            app().togglePanel('settings', false)
            app().togglePanel('trash', true)
          }}
        >
          Open trash
        </button>
      </div>
      {!canWrite && ready && (
        <p className="m-0 border-b border-bone/10 px-5 py-2 text-ember">
          Read-only tab: another tab is editing this world. Changes here are disabled; export still works.
        </p>
      )}
      <StorageSection />
      <EngineSection canWrite={canWrite} />
      <SemanticSection canWrite={canWrite} />
      <BackupsSection canWrite={canWrite} />
      <ImportSection canWrite={canWrite} />
      <RelayoutSection canWrite={canWrite} />
      <QualitySection canWrite={canWrite} />
      <Section title="Credits" intro="Fonts, scanned scenes and libraries this app is built on.">
        <Credits />
      </Section>
      <DangerSection canWrite={canWrite} />
    </HudDialog>
  )
}

/** Settings modal (useApp panels.settings). */
export function Settings() {
  const open = useApp((s) => s.panels.settings)
  return open ? <SettingsPanel /> : null
}
