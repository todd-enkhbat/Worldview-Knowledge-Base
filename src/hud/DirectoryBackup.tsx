import { useState } from 'react'
import { directoryBundleReader, directoryBundleWriter, exportDirectoryBundle, verifyDirectoryBundle, type BundleProgress, type DirectoryBundleManifest } from '../data/directoryBundle.ts'
import { exportWorldDirectory, getStore, importWorldDirectory } from '../data/repo.ts'
import { BTN, ConfirmDialog } from './DurabilityKit.tsx'

type DirectoryPicker = (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
const picker = (): DirectoryPicker | undefined => (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const cancelled = (error: unknown) => (error as { name?: string })?.name === 'AbortError'

export function DirectoryBackup({ canWrite }: { canWrite: boolean }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<BundleProgress | null>(null)
  const [restore, setRestore] = useState<{ handle: FileSystemDirectoryHandle; manifest: DirectoryBundleManifest } | null>(null)

  async function save() {
    const choose = picker()
    if (!choose) return
    setBusy(true); setError(''); setNotice('')
    try {
      const parent = await choose({ mode: 'readwrite' })
      const name = `Worldview-backup-${stamp()}-${crypto.randomUUID().slice(0, 8)}`
      const directory = await parent.getDirectoryHandle(name, { create: true })
      await exportWorldDirectory(directoryBundleWriter(directory), { onProgress: setProgress })
      await verifyDirectoryBundle(directoryBundleReader(directory), { onProgress: setProgress })
      setNotice(`Saved and verified ${name}. Keep the whole folder together.`)
    } catch (failure) { if (!cancelled(failure)) setError(errorText(failure)) }
    finally { setBusy(false); setProgress(null) }
  }

  async function chooseRestore() {
    const choose = picker()
    if (!choose) return
    setBusy(true); setError(''); setNotice('')
    try {
      const handle = await choose({ mode: 'readwrite' })
      const verified = await verifyDirectoryBundle(directoryBundleReader(handle), { onProgress: setProgress })
      setRestore({ handle, manifest: verified.manifest })
    } catch (failure) { if (!cancelled(failure)) setError(errorText(failure)) }
    finally { setBusy(false); setProgress(null) }
  }

  async function confirmRestore() {
    if (!restore) return
    const selected = restore
    setBusy(true); setError('')
    try {
      const result = await importWorldDirectory(directoryBundleReader(selected.handle), {
        replace: true, onProgress: setProgress,
        backup: async () => {
          const name = `Before-restore-${stamp()}-${crypto.randomUUID().slice(0, 8)}`
          const handle = await selected.handle.getDirectoryHandle(name, { create: true })
          await exportDirectoryBundle(getStore(), directoryBundleWriter(handle))
          return { name, reader: directoryBundleReader(handle) }
        },
      })
      setNotice(`Restored ${result.nodes} records and ${result.assets} original assets. ${result.backupName ? `The previous workspace is in ${result.backupName} inside the selected folder.` : ''}`)
      setRestore(null)
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false); setProgress(null) }
  }

  if (!picker()) return <p className="m-0 text-sm text-bone/75">Large folder backups are available in browsers with directory access, including Chrome and Edge. ZIP backups remain available here.</p>
  return <div className="space-y-3 border-t border-bone/10 pt-4 text-sm">
    <h4 className="m-0 font-medium">Folder backups for a large record</h4>
    <p className="m-0 text-bone/75">Originals, source versions and your research context are saved in verified parts. This format supports records larger than a single ZIP archive.</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={BTN} disabled={busy} onClick={() => void save()}>Save folder backup</button><button type="button" className={BTN} disabled={busy || !canWrite} onClick={() => void chooseRestore()}>Restore folder backup</button></div>
    {progress && <p role="status" className="m-0 text-bone/75">{progress.phase} · {Math.round(progress.done / Math.max(1, progress.total) * 100)}%</p>}
    {notice && <p role="status" className="m-0 text-glass">{notice}</p>}
    {error && <p role="alert" className="m-0 text-signal">{error}</p>}
    {restore && <ConfirmDialog title="Restore folder backup" confirmLabel="Back up and restore" onCancel={() => setRestore(null)} onConfirm={() => void confirmRestore()} busy={busy}>
      <p>This verified backup contains {restore.manifest.counts.nodes} records and {restore.manifest.counts.assets} assets. Restoring replaces the current workspace.</p>
      <p>A verified copy of the current workspace will be saved inside the selected folder before replacement. Keep that folder if you need to recover it.</p>
    </ConfirmDialog>}
  </div>
}
