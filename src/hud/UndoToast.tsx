import { useEffect, useRef, useState } from 'react'
import { useApp } from '../app/store.ts'
import type { UndoToast as UndoToastData } from '../app/store.ts'
import { errorText, toastRemaining } from './durability.ts'
import { BTN, FOCUS, Overlay } from './DurabilityKit.tsx'

/** After a hover or focus pause, a toast gets at least this long again (WCAG 2.2.1: timing adjustable). */
const RESUME_MIN_MS = 2500
/** How long an "Undo failed" message stays. */
const FAILED_MS = 6000

function ToastItem({ toast }: { toast: UndoToastData }) {
  const dismiss = useApp((s) => s.dismissToast)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The store's expiresAt is fixed; a paused toast keeps its own deadline here.
  const deadline = useRef(toast.expiresAt)

  useEffect(() => {
    if (paused || busy) return
    const t = setTimeout(() => dismiss(toast.id), toastRemaining(deadline.current, Date.now()))
    return () => clearTimeout(t)
  }, [paused, busy, dismiss, toast.id])

  const pause = () => setPaused(true)
  const resume = () => {
    deadline.current = Math.max(deadline.current, Date.now() + RESUME_MIN_MS)
    setPaused(false)
  }

  const onUndo = async () => {
    setBusy(true)
    try {
      await toast.undo()
      dismiss(toast.id)
    } catch (e) {
      setFailed(`Undo failed: ${errorText(e)}`)
      deadline.current = Date.now() + FAILED_MS
      setBusy(false)
    }
  }

  return (
    <li
      className="hud-panel pointer-events-auto flex min-w-[18rem] max-w-[min(32rem,calc(100vw-2rem))] items-center gap-3 px-3 py-2"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume()
      }}
    >
      <span className={`min-w-0 flex-1 truncate ${failed ? 'text-signal' : 'text-bone'}`} title={failed ?? toast.message}>
        {failed ?? toast.message}
      </span>
      {!failed && (
        <button type="button" className={BTN} onClick={onUndo} disabled={busy} aria-busy={busy}>
          {busy ? 'Undoing…' : 'Undo'}
        </button>
      )}
      <button
        type="button"
        className={`px-1 font-mono text-[11px] text-concrete hover:text-bone ${FOCUS}`}
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        disabled={busy}
      >
        ✕
      </button>
    </li>
  )
}

/** Undo toasts from useApp, bottom-centre. Each expires on its own timer; hover or focus pauses it. */
export function UndoToasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <Overlay>
      <div aria-live="polite" aria-relevant="additions text" className="pointer-events-none fixed inset-x-0 bottom-6 z-[55] flex justify-center px-4">
        <ul className="m-0 flex list-none flex-col items-center gap-2 p-0 font-mono text-[12px]">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} />
          ))}
        </ul>
      </div>
    </Overlay>
  )
}

export { UndoToasts as UndoToast }
