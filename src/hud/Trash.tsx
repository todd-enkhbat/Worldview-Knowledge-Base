import { useEffect, useMemo, useState } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { TRASH_RETENTION_MS } from '../domain/constants.ts'
import type { NodeRecord } from '../domain/types.ts'
import { emptyTrash, purgeExpiredTrash, restore, useRepoStatus } from '../data/repo.ts'
import { DAY_MS, errorText, formatDay, plural, trashDaysLeft } from './durability.ts'
import { BTN, BTN_DANGER, ConfirmDialog, HudDialog, useNow } from './DurabilityKit.tsx'

const RETENTION_DAYS = Math.round(TRASH_RETENTION_MS / DAY_MS)

function TrashRow({ record, now, canWrite, onRestored }: { record: NodeRecord; now: number; canWrite: boolean; onRestored: (r: NodeRecord) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const left = record.deletedAt === null ? RETENTION_DAYS : trashDaysLeft(record.deletedAt, now)
  const onRestore = async () => {
    setBusy(true)
    setError(null)
    try {
      onRestored(await restore(record.id))
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <li className="flex items-start gap-4 border-b border-bone/10 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-bone" title={record.title}>
          {record.title || 'Untitled'}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] uppercase tracking-[0.14em] text-concrete">
          <span>{record.archetype}</span>
          {record.deletedAt !== null && <span>Deleted {formatDay(record.deletedAt)}</span>}
          <span className={left <= 3 ? 'text-signal' : ''}>{left === 0 ? 'Purged on next open' : `${plural(left, 'day')} left`}</span>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-signal">
            {error}
          </p>
        )}
      </div>
      <button type="button" className={BTN} onClick={onRestore} disabled={!canWrite || busy} aria-busy={busy} aria-label={`Restore ${record.title || 'untitled record'}`}>
        {busy ? 'Restoring…' : 'Restore'}
      </button>
    </li>
  )
}

function TrashPanel() {
  const trash = useWorld((s) => s.trash)
  const { writer, fallback } = useRepoStatus()
  const canWrite = writer || fallback
  const now = useNow()
  const [confirming, setConfirming] = useState(false)
  const [emptying, setEmptying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const close = () => useApp.getState().escape()

  // Retention is enforced on open (as well as at boot), so the list never shows the expired.
  useEffect(() => {
    if (!canWrite) return
    purgeExpiredTrash()
      .then((ids) => {
        if (ids.length) setNotice(`${plural(ids.length, 'record')} older than ${RETENTION_DAYS} days purged.`)
      })
      .catch((e) => setError(errorText(e)))
  }, [canWrite])

  const records = useMemo(() => [...trash.values()].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)), [trash])

  const onEmpty = async () => {
    setEmptying(true)
    setError(null)
    try {
      const ids = await emptyTrash({ confirm: true })
      setNotice(`Trash emptied: ${plural(ids.length, 'record')} deleted for good.`)
      setConfirming(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setEmptying(false)
    }
  }

  return (
    <HudDialog title={`Trash · ${records.length}`} onClose={close}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-bone/15 px-5 py-3">
        <p className="m-0 max-w-md text-concrete">
          Deleted records wait here {RETENTION_DAYS} days, then are erased with their attachments.
        </p>
        <button type="button" className={BTN_DANGER} onClick={() => setConfirming(true)} disabled={!canWrite || records.length === 0}>
          Empty trash
        </button>
      </div>
      {!canWrite && <p className="m-0 border-b border-bone/15 px-5 py-2 text-ember">Read-only tab: restore and empty from the tab that is editing.</p>}
      <div aria-live="polite" className="empty:hidden">
        {notice && <p className="m-0 border-b border-bone/15 px-5 py-2 text-glass">{notice}</p>}
      </div>
      {error && (
        <p role="alert" className="m-0 border-b border-bone/15 px-5 py-2 text-signal">
          {error}
        </p>
      )}
      {records.length === 0 ? (
        <p className="m-0 px-5 py-10 text-center uppercase tracking-[0.2em] text-concrete">Trash is empty</p>
      ) : (
        <ul className="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
          {records.map((r) => (
            <TrashRow key={r.id} record={r} now={now} canWrite={canWrite} onRestored={(n) => setNotice(`Restored “${n.title}”.`)} />
          ))}
        </ul>
      )}
      {confirming && (
        <ConfirmDialog title="Empty trash" confirmLabel="Delete forever" danger busy={emptying} onConfirm={onEmpty} onCancel={() => setConfirming(false)}>
          <p className="m-0">
            Permanently erase {plural(records.length, 'record')} and their attachments. Links pointing at them are removed. This cannot be undone.
          </p>
          <p className="m-0 text-concrete">An export made before now still contains them.</p>
        </ConfirmDialog>
      )}
    </HudDialog>
  )
}

/** Trash modal (useApp panels.trash). Purges expired records when opened. */
export function Trash() {
  const open = useApp((s) => s.panels.trash)
  return open ? <TrashPanel /> : null
}
