import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { autoBackupSupported, needsRegrant, regrantBackupFolder, shouldNag } from '../data/autoBackup.ts'
import { backupNow, dismissInterruptedImport, getStore, isRepoReady, recoverInterruptedImport, useRepoStatus } from '../data/repo.ts'
import { activeBanners, backupAgeLabel, errorSuggestsReload, errorText } from './durability.ts'
import type { BannerKind } from './durability.ts'
import { BTN, FOCUS, saveWorldArchive, useNow } from './DurabilityKit.tsx'

type Tone = 'alarm' | 'warn' | 'plain'

const TONE: Readonly<Record<Tone, string>> = {
  alarm: 'border-signal bg-signal text-void',
  warn: 'border-ember/50 bg-void/90 text-bone',
  plain: 'border-bone/20 bg-void/90 text-bone',
}
const LABEL_TONE: Readonly<Record<Tone, string>> = { alarm: 'text-void', warn: 'text-ember', plain: 'text-concrete' }
/** A button that stays legible on the solid signal strip. */
const BTN_ON_ALARM = `border border-void px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-void hover:bg-void hover:text-signal disabled:opacity-50 ${FOCUS.replace('outline-signal', 'outline-void')}`

// Dismissing the nag lasts for this page load only: it must come back tomorrow.
let nagDismissedThisLoad = false

function Banner({ tone, label, urgent = false, children, actions }: { tone: Tone; label: string; urgent?: boolean; children: ReactNode; actions?: ReactNode }) {
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={`pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 font-mono text-[11px] leading-snug ${TONE[tone]}`}
    >
      <strong className={`text-[10px] uppercase tracking-[0.2em] ${LABEL_TONE[tone]}`}>{label}</strong>
      <span className="min-w-0 flex-1">{children}</span>
      {actions && <span className="flex shrink-0 flex-wrap gap-2">{actions}</span>}
    </div>
  )
}

function useActionState() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, run, clear: () => setError(null) }
}

export interface BannersProps {
  /** Positioning is the host's job (e.g. "absolute inset-x-0 top-0 z-40"). */
  className?: string
}

/**
 * Durability banners, most urgent first: memory-only fallback, interrupted import, repo
 * errors (reload), read-only tab, auto-backup failure / lost folder permission, backup nag.
 */
export function Banners({ className = '' }: BannersProps) {
  const status = useRepoStatus()
  const settings = useWorld((s) => s.settings)
  const now = useNow(60 * 60_000)
  const [nagDismissed, setNagDismissed] = useState(nagDismissedThisLoad)
  const [regrant, setRegrant] = useState(false)
  const [regrantCheck, setRegrantCheck] = useState(0)
  const { busy, error, run, clear } = useActionState()

  const autoOn = settings?.autoBackupEnabled === true
  useEffect(() => {
    if (!status.ready || !status.writer || !autoOn || !autoBackupSupported() || !isRepoReady()) {
      setRegrant(false)
      return
    }
    let live = true
    needsRegrant(getStore())
      .then((v) => live && setRegrant(v))
      .catch(() => live && setRegrant(false))
    return () => {
      live = false
    }
  }, [status.ready, status.writer, autoOn, regrantCheck])

  const kinds = activeBanners({
    ready: status.ready,
    fallback: status.fallback,
    writer: status.writer,
    error: status.error,
    interruptedImport: status.interruptedImport !== null,
    backupError: status.backupError,
    needsRegrant: regrant,
    nag: settings !== null && shouldNag(settings, now),
    nagDismissed,
    firstRunDone: settings?.firstRunComplete === true,
  })
  if (kinds.length === 0 && !error) return null

  const exportNow = () => run('export', () => saveWorldArchive())
  const openSettings = () => useApp.getState().togglePanel('settings', true)

  const render = (k: BannerKind) => {
    switch (k) {
      case 'memory':
        return (
          <Banner key={k} tone="alarm" label="Memory only" urgent actions={<button type="button" className={BTN_ON_ALARM} onClick={exportNow} disabled={busy !== null}>{busy === 'export' ? 'Exporting…' : 'Export now'}</button>}>
            Browser storage is unavailable (private window?). Nothing will be saved: this world disappears when the tab closes.
          </Banner>
        )
      case 'interrupted-import': {
        const marker = status.interruptedImport
        return (
          <Banner
            key={k}
            tone="alarm"
            label="Import interrupted"
            urgent
            actions={
              <>
                {marker?.backupName && (
                  <button
                    type="button"
                    className={BTN_ON_ALARM}
                    disabled={busy !== null || !status.writer}
                    onClick={() =>
                      run('recover', async () => {
                        if (!(await recoverInterruptedImport())) throw new Error('The pre-import backup could not be found. Keep what is here, or import an export.')
                      })
                    }
                  >
                    {busy === 'recover' ? 'Restoring…' : 'Restore backup'}
                  </button>
                )}
                <button type="button" className={BTN_ON_ALARM} disabled={busy !== null || !status.writer} onClick={() => run('keep', dismissInterruptedImport)}>
                  Keep what is here
                </button>
              </>
            }
          >
            An import stopped partway{marker ? ` (started ${new Date(marker.startedAt).toLocaleString()})` : ''}, so this world may be incomplete.
            {marker?.backupName ? ' The world from before the import was saved automatically.' : ' No pre-import backup was taken.'}
          </Banner>
        )
      }
      case 'error':
        return (
          <Banner
            key={k}
            tone="alarm"
            label="Storage"
            urgent
            actions={
              errorSuggestsReload(status.error ?? '') ? (
                <button type="button" className={BTN_ON_ALARM} onClick={() => location.reload()}>
                  Reload
                </button>
              ) : undefined
            }
          >
            {status.error}
          </Banner>
        )
      case 'read-only':
        return (
          <Banner key={k} tone="warn" label="Read-only">
            This world is open for editing in another tab; this tab follows along. Close that tab and this one takes over automatically.
          </Banner>
        )
      case 'backup-error':
        return (
          <Banner
            key={k}
            tone="warn"
            label="Backup failed"
            actions={
              <>
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => run('retry', backupNow)}>
                  {busy === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
                <button type="button" className={BTN} onClick={openSettings}>
                  Settings
                </button>
              </>
            }
          >
            The automatic backup to your folder failed: {status.backupError}
          </Banner>
        )
      case 'backup-regrant':
        return (
          <Banner
            key={k}
            tone="warn"
            label="Backups paused"
            actions={
              <button
                type="button"
                className={BTN}
                disabled={busy !== null}
                onClick={() =>
                  run('regrant', async () => {
                    // requestPermission must run inside this click, before any other await.
                    const ok = await regrantBackupFolder(getStore())
                    setRegrantCheck((n) => n + 1)
                    if (!ok) throw new Error('Folder access was not granted. Automatic backups stay paused.')
                    await backupNow()
                  })
                }
              >
                {busy === 'regrant' ? 'Asking…' : 'Allow folder access'}
              </button>
            }
          >
            The browser needs your permission again to write automatic backups to your folder.
          </Banner>
        )
      case 'backup-nag': {
        const never = settings?.lastBackupAt === null
        return (
          <Banner
            key={k}
            tone="plain"
            label="Back up"
            actions={
              <>
                <button type="button" className={BTN} onClick={exportNow} disabled={busy !== null}>
                  {busy === 'export' ? 'Exporting…' : 'Export now'}
                </button>
                <button
                  type="button"
                  className={BTN}
                  onClick={() => {
                    nagDismissedThisLoad = true
                    setNagDismissed(true)
                  }}
                  aria-label="Dismiss backup reminder for now"
                >
                  Later
                </button>
              </>
            }
          >
            {never
              ? 'This world has never been exported. It lives only in this browser.'
              : `Last backup ${backupAgeLabel(settings?.lastBackupAt ?? null, now)}. Browser storage is the only copy.`}
          </Banner>
        )
      }
    }
  }

  return (
    <div className={`flex flex-col ${className}`}>
      {kinds.map(render)}
      {error && (
        <Banner
          tone="alarm"
          label="Failed"
          urgent
          actions={
            <button type="button" className={BTN_ON_ALARM} onClick={clear}>
              Dismiss
            </button>
          }
        >
          {error}
        </Banner>
      )}
    </div>
  )
}
