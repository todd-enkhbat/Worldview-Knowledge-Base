import { useEffect, useState } from 'react'
import { MAX_ATTACHMENT_BYTES } from '../../data/attachments.ts'
import { getStore } from '../../data/repo.ts'
import type { Attachment } from '../../domain/types.ts'
import { ERROR_TEXT, FOCUS, HINT_TEXT, formatBytes } from './ui.ts'

export interface AttachmentFieldProps {
  id: string
  /** Attachments already stored on the node. */
  existing: Attachment[]
  /** Existing attachments marked for removal on save. */
  removedIds: ReadonlySet<string>
  onToggleRemove: (attachmentId: string) => void
  /** Files chosen in this session, written on save. */
  pending: File[]
  onAdd: (files: File[]) => void
  onRemovePending: (index: number) => void
}

const ACCEPT = 'image/*,text/*,.md,.markdown,.txt,.csv,.tsv,.json,.log'

/**
 * Attachments are staged, not written: removals and new files apply on Save so Cancel really
 * cancels. New images preview from an object URL of the picked file.
 */
export function AttachmentField({ id, existing, removedIds, onToggleRemove, pending, onAdd, onRemovePending }: AttachmentFieldProps) {
  const [tooBig, setTooBig] = useState<string[]>([])

  return (
    <div>
      <label htmlFor={id} className="hud-label mb-1.5 block">
        Attachments
      </label>

      {(existing.length > 0 || pending.length > 0) && (
        <ul className="mb-2 flex flex-col gap-1">
          {existing.map((a) => {
            const removed = removedIds.has(a.id)
            return (
              <li key={a.id} className={`flex items-center gap-2 border border-bone/15 p-1 ${removed ? 'opacity-50' : ''}`}>
                <StoredThumb attachment={a} />
                <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${removed ? 'line-through' : ''}`}>{a.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-concrete">{formatBytes(a.bytes)}</span>
                <button
                  type="button"
                  className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                    removed
                      ? 'border-bone/30 text-bone hover:bg-bone hover:text-void'
                      : 'border-bone/30 text-concrete hover:border-signal hover:bg-signal hover:text-void'
                  } ${FOCUS}`}
                  aria-label={removed ? `Keep ${a.name}` : `Remove ${a.name} on save`}
                  aria-pressed={removed}
                  onClick={() => onToggleRemove(a.id)}
                >
                  {removed ? 'Keep' : 'Remove'}
                </button>
              </li>
            )
          })}
          {pending.map((f, i) => (
            <li key={`${f.name}:${f.size}:${f.lastModified}:${i}`} className="flex items-center gap-2 border border-dashed border-brass/50 p-1">
              <PendingThumb file={f} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.name}</span>
              <span className="shrink-0 font-mono text-[10px] uppercase text-brass">new · {formatBytes(f.size)}</span>
              <button
                type="button"
                className={`shrink-0 border border-bone/30 px-1.5 py-0.5 font-mono text-[11px] text-concrete hover:border-signal hover:bg-signal hover:text-void ${FOCUS}`}
                aria-label={`Discard ${f.name}`}
                onClick={() => onRemovePending(i)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        id={id}
        type="file"
        multiple
        accept={ACCEPT}
        aria-describedby={`${id}-hint`}
        className={
          'block w-full font-mono text-[11px] text-concrete file:mr-2 file:cursor-pointer file:border file:border-bone/30 ' +
          'file:bg-transparent file:px-2 file:py-1 file:font-mono file:text-[11px] file:uppercase file:tracking-wider file:text-bone ' +
          `hover:file:bg-bone hover:file:text-void ${FOCUS}`
        }
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = '' // so picking the same file again still fires
          const ok = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)
          setTooBig(files.filter((f) => f.size > MAX_ATTACHMENT_BYTES).map((f) => f.name))
          if (ok.length > 0) onAdd(ok)
        }}
      />
      <p id={`${id}-hint`} className={HINT_TEXT}>
        Images or text files, up to {MAX_ATTACHMENT_BYTES >> 20} MB each. Stored in this browser only.
      </p>
      {tooBig.length > 0 && (
        <p className={ERROR_TEXT} role="alert">
          Too large (over {MAX_ATTACHMENT_BYTES >> 20} MB): {tooBig.join(', ')}
        </p>
      )}
    </div>
  )
}

const THUMB = 'h-9 w-9 shrink-0 border border-bone/20 bg-bone/5 object-cover'

function Placeholder({ label }: { label: string }) {
  return (
    <span className={`${THUMB} flex items-center justify-center font-mono text-[9px] uppercase text-concrete`} aria-hidden="true">
      {label}
    </span>
  )
}

/** Object URL for a blob, revoked when the blob changes or the row unmounts. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => {
      URL.revokeObjectURL(u)
      setUrl(null)
    }
  }, [blob])
  return url
}

function PendingThumb({ file }: { file: File }) {
  const isImage = file.type.startsWith('image/')
  const url = useObjectUrl(isImage ? file : null)
  if (!isImage) return <Placeholder label="txt" />
  return url ? <img src={url} alt="" className={THUMB} /> : <Placeholder label="img" />
}

function StoredThumb({ attachment }: { attachment: Attachment }) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const thumbId = attachment.thumbBlobId
  useEffect(() => {
    if (!thumbId) return
    let live = true
    let store: ReturnType<typeof getStore>
    try {
      store = getStore()
    } catch {
      return // repo not ready: the placeholder stays
    }
    store
      .getBlob(thumbId)
      .then((b) => {
        if (live && b) setBlob(b)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [thumbId])
  const url = useObjectUrl(blob)
  if (attachment.kind !== 'image') return <Placeholder label="txt" />
  return url ? <img src={url} alt="" className={THUMB} /> : <Placeholder label="img" />
}
