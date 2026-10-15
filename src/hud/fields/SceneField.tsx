import { useEffect, useState, type DragEvent } from 'react'
import { useApp, useWorld } from '../../app/store.ts'
import { getStore, useRepoStatus } from '../../data/repo.ts'
import { detachScene } from '../../data/scenes.ts'
import type { SplatBlock } from '../../domain/types.ts'
import { cancelIngest, dismissIngest, startIngest, useIngestJobs, type IngestJobState } from '../../world/splats/ingest/jobs.ts'
import { ACCEPTED_EXTENSIONS } from '../../world/splats/ingest/sniff.ts'
import { BTN, BTN_SIGNAL, ERROR_TEXT, FOCUS, HINT_TEXT } from './ui.ts'

// Volumetric scene of a memory (NodeEditor "Volumetric scene" section). Unlike attachments
// this is not staged: a splat file is minutes of decode work and hundreds of MB, so it is
// ingested and stored straight away (needs a saved node), and Remove asks for confirmation.

/** Object URL for a stored blob (attachment image, its thumbnail, a splat thumbnail). */
export function useStoredBlobUrl(blobId: string | null | undefined): string | null {
  const [blob, setBlob] = useState<{ id: string; blob: Blob } | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blobId) return
    let live = true
    let store: ReturnType<typeof getStore>
    try {
      store = getStore()
    } catch {
      return // repo not ready
    }
    store
      .getBlob(blobId)
      .then((b) => {
        if (live && b) setBlob({ id: blobId, blob: b })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [blobId])
  const current = blob && blob.id === blobId ? blob.blob : null
  useEffect(() => {
    if (!current) return
    const u = URL.createObjectURL(current)
    setUrl(u)
    return () => {
      URL.revokeObjectURL(u)
      setUrl(null)
    }
  }, [current])
  return current ? url : null
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  return String(n)
}

/** Splat thumbnail (or a placeholder) for a scene block. */
export function SceneThumb({ splat, className = 'h-24 w-24' }: { splat: SplatBlock; className?: string }) {
  const url = useStoredBlobUrl(splat.thumbAssetId)
  const base = `${className} shrink-0 border border-bone/20 bg-void`
  return url ? (
    <img src={url} alt="Scene thumbnail" className={`${base} object-cover`} />
  ) : (
    <span className={`${base} flex items-center justify-center font-mono text-[9px] uppercase text-concrete`} aria-hidden="true">
      splat
    </span>
  )
}

/** Progress bar for an in-flight ingest ("crystallising …"). */
export function IngestProgressBar({ job, onCancel }: { job: IngestJobState; onCancel?: () => void }) {
  const pct = Math.round(job.progress.fraction * 100)
  return (
    <div className="flex flex-col gap-1" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-2 font-mono text-[11px] text-bone">
        <span className="min-w-0 truncate">
          crystallising {job.fileName} · {job.progress.label}…
        </span>
        <span className="shrink-0 text-concrete">{pct}%</span>
      </div>
      <div
        className="h-1.5 w-full border border-bone/30 bg-void"
        role="progressbar"
        aria-label={`Ingesting ${job.fileName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full bg-brass transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      {onCancel && (
        <button type="button" className={`${BTN} self-start`} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  )
}

export interface SceneFieldProps {
  id: string
  /** Stored memory id; null while the memory has not been saved yet. */
  nodeId: string | null
}

export function SceneField({ id, nodeId }: SceneFieldProps) {
  const node = useWorld((s) => (nodeId ? s.nodes.get(nodeId) : undefined))
  const job = useIngestJobs((s) => (nodeId ? s.jobs[nodeId] : undefined))
  const writer = useRepoStatus((s) => s.writer)
  const [dragging, setDragging] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!nodeId || !node) {
    return (
      <p id={`${id}-hint`} className={HINT_TEXT}>
        Save the memory first, then add its volumetric scene (a Gaussian-splat capture: {ACCEPTED_EXTENSIONS.join(' ')}).
      </p>
    )
  }

  const splat = node.splat
  const running = job?.running === true
  const disabled = !writer || running || removing

  const ingest = (file: File | undefined) => {
    if (!file || disabled) return
    setError(null)
    setConfirmRemove(false)
    void startIngest(nodeId, file)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    ingest(e.dataTransfer.files[0])
  }

  const remove = async () => {
    setRemoving(true)
    setError(null)
    try {
      await detachScene(nodeId)
      setConfirmRemove(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(false)
    }
  }

  const frame = () => {
    const app = useApp.getState()
    app.focus(nodeId)
    if (!app.setMode('framing')) setError(`Cannot frame from ${app.mode} mode; return to the world first.`)
  }

  return (
    <div className="flex flex-col gap-3">
      {splat && !running && (
        <div className="flex gap-3">
          <SceneThumb splat={splat} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
              <dt className="text-concrete">interior</dt>
              <dd className="m-0 text-bone">{formatCount(splat.counts.interior)} splats</dd>
              <dt className="text-concrete">proxy</dt>
              <dd className="m-0 text-bone">{formatCount(splat.counts.proxy)} splats</dd>
              <dt className="text-concrete">source</dt>
              <dd className="m-0 uppercase text-bone">{splat.sourceFormat}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN} onClick={frame}>
                Frame scene
              </button>
              {confirmRemove ? (
                <>
                  <button type="button" className={BTN_SIGNAL} disabled={disabled} onClick={() => void remove()}>
                    {removing ? 'Removing…' : 'Confirm remove'}
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmRemove(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className={BTN} disabled={disabled} onClick={() => setConfirmRemove(true)}>
                  Remove scene
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {running && job && <IngestProgressBar job={job} onCancel={() => cancelIngest(nodeId)} />}

      {!running && (
        <div
          onDragOver={(e) => {
            if (disabled) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`border border-dashed p-3 ${dragging ? 'border-brass bg-brass/10' : 'border-bone/25'}`}
        >
          <label htmlFor={id} className="hud-label mb-1.5 block">
            {splat ? 'Replace with another capture' : 'Add a volumetric scene'}
          </label>
          <input
            id={id}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(',')}
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            className={
              'block w-full font-mono text-[11px] text-concrete file:mr-2 file:cursor-pointer file:border file:border-bone/30 ' +
              'file:bg-transparent file:px-2 file:py-1 file:font-mono file:text-[11px] file:uppercase file:tracking-wider file:text-bone ' +
              `hover:file:bg-bone hover:file:text-void disabled:opacity-40 ${FOCUS}`
            }
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = '' // so picking the same file again still fires
              ingest(f)
            }}
          />
          <p id={`${id}-hint`} className={HINT_TEXT}>
            Drop or pick a Gaussian-splat capture ({ACCEPTED_EXTENSIONS.join(' ')}). It is converted to SPZ and stored in this browser
            {splat ? '; the current scene is replaced once the new one is ready' : ''}.
          </p>
        </div>
      )}

      {job?.error && (
        <div className="flex items-start gap-2">
          <p className={`${ERROR_TEXT} m-0 flex-1`} role="alert">
            Could not add the scene: {job.error}
          </p>
          <button type="button" className={BTN} onClick={() => dismissIngest(nodeId)}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className={ERROR_TEXT} role="alert">
          {error}
        </p>
      )}
      {!writer && <p className={HINT_TEXT}>Read-only: another tab is the writer.</p>}
    </div>
  )
}
