import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { blobSink, defaultArchiveName, writableSink } from '../data/archive.ts'
import type { ArchiveProgress, ExportResult } from '../data/archive.ts'
import { exportWorld } from '../data/repo.ts'

// Shared pieces of the durability HUD: button classes, a modal dialog with Esc and a focus
// trap, a confirm dialog, the export-to-disk helper and the captured install prompt.

export const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal'

/** Neutral button (the .hud-btn primitive plus a visible focus ring). */
export const BTN = `hud-btn ${FOCUS}`

// .hud-btn is unlayered CSS, so it would beat utilities that try to recolour it. The signal
// variants are therefore spelled out in full instead of layered on top of .hud-btn.
const BTN_BASE = `border px-2 py-1 font-mono text-[11px] uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`
/** Primary emphasis: solid signal orange. */
export const BTN_PRIMARY = `${BTN_BASE} border-signal bg-signal text-void hover:bg-transparent hover:text-signal disabled:hover:bg-signal disabled:hover:text-void`
/** Destructive: signal outline. */
export const BTN_DANGER = `${BTN_BASE} border-signal text-signal hover:bg-signal hover:text-void disabled:hover:bg-transparent disabled:hover:text-signal`

/**
 * Fixed overlays go to <body> through a portal: .hud-panel has a backdrop-filter, which makes
 * it the containing block of any position:fixed descendant, so a dialog rendered inside a
 * panel would be clipped to that panel. React events still bubble through the React tree.
 */
export function Overlay({ children }: { children: ReactNode }) {
  return typeof document === 'undefined' ? null : createPortal(children, document.body)
}

/** Wall clock that re-renders every `intervalMs` (day counters, backup age). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Reachable with Tab: not tabindex=-1, rendered, and for a radio group only its checked (or, with none checked, any) member. */
function isTabbable(el: HTMLElement, container: HTMLElement): boolean {
  if (el.tabIndex < 0) return false
  if (el !== document.activeElement && el.getClientRects().length === 0) return false
  if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && el.name) {
    return !container.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`)
  }
  return true
}

/**
 * Keyboard handling shared by every full-screen or modal surface: claim all keys so the
 * camera rig (a window listener in the bubble phase) never sees F/T/O/Esc typed here, run
 * `onEscape`, and keep Tab inside `container`.
 */
export function trapKeys(e: ReactKeyboardEvent, container: HTMLElement | null, onEscape: (() => void) | null): void {
  e.stopPropagation()
  if (e.key === 'Escape') {
    if (!onEscape) return
    e.preventDefault()
    onEscape()
    return
  }
  if (e.key !== 'Tab' || !container) return
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => isTabbable(el, container))
  if (items.length === 0) {
    e.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

/** Focus `ref` (or the container) on mount and give focus back to the opener on unmount. */
function useFocusOnMount(container: RefObject<HTMLElement | null>, initial?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ;(initial?.current ?? container.current)?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
    // Mount-only: re-focusing on every render would steal focus from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export interface HudDialogProps {
  title: string
  /** Esc and the close button. For app panels pass () => useApp.getState().escape(). */
  onClose: () => void
  children: ReactNode
  /** Element to focus on open (default: the dialog itself). */
  initialFocus?: RefObject<HTMLElement | null>
  /** Tailwind max-width class (default max-w-2xl). */
  width?: string
  /** Stack above another dialog. */
  nested?: boolean
  /** role="alertdialog" for confirmations. */
  alert?: boolean
}

export function HudDialog({ title, onClose, children, initialFocus, width = 'max-w-2xl', nested = false, alert = false }: HudDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusOnMount(ref, initialFocus)
  return createPortal(
    <div
      className={`fixed inset-0 ${nested ? 'z-[70]' : 'z-50'} flex items-start justify-center overflow-y-auto bg-void/75 p-4 sm:p-10`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => trapKeys(e, ref.current, onClose)}
        className={`hud-panel relative w-full ${width} outline-none`}
      >
        <header className="flex items-center justify-between gap-4 border-b border-bone/15 px-5 py-3">
          <h2 id={titleId} className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-bone">
            {title}
          </h2>
          <button type="button" className={BTN} onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            Esc ✕
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
  /** Destructive confirm button (signal outline) instead of primary. */
  danger?: boolean
}

/** Confirmation stacked over a panel. Focus starts on Cancel so Enter never confirms by accident. */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, busy = false, danger = false }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <HudDialog title={title} onClose={busy ? () => {} : onCancel} initialFocus={cancelRef} width="max-w-lg" nested alert>
      <div className="space-y-3 px-5 py-4 leading-relaxed text-bone/90">{children}</div>
      <footer className="flex justify-end gap-2 border-t border-bone/15 px-5 py-3">
        <button ref={cancelRef} type="button" className={BTN} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={danger ? BTN_DANGER : BTN_PRIMARY} onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </footer>
    </HudDialog>
  )
}

/** A section heading in the brutalist micro-label style, with a hairline above. */
export function SectionHead({ id, children, tone = 'label' }: { id: string; children: ReactNode; tone?: 'label' | 'danger' }) {
  return (
    <h3 id={id} className={`hud-label mb-3 ${tone === 'danger' ? 'text-signal' : ''}`}>
      {children}
    </h3>
  )
}

// ─── export to disk ────────────────────────────────────────────────────────────────

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string
    id?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

export type SaveWorldResult = { method: 'picker' | 'download'; result: ExportResult } | { method: 'cancelled' }

/**
 * "Export now": the same picker/download strategy as archive.saveArchive, but through
 * repo.exportWorld so the export runs in the repo's action queue and stamps lastBackupAt
 * (which clears the backup nag). Call it straight from a click handler: the save picker
 * needs the user gesture, so nothing may be awaited before it opens.
 */
export async function saveWorldArchive(onProgress?: (p: ArchiveProgress) => void): Promise<SaveWorldResult> {
  const name = defaultArchiveName(Date.now())
  const picker = (globalThis as SaveFilePickerWindow).showSaveFilePicker
  if (typeof picker === 'function') {
    let handle: FileSystemFileHandle
    try {
      handle = await picker({
        suggestedName: name,
        id: 'hyperspace-export',
        types: [{ description: 'Hyperspace archive', accept: { 'application/zip': ['.zip'] } }],
      })
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return { method: 'cancelled' }
      throw e
    }
    const writable = await handle.createWritable()
    return { method: 'picker', result: await exportWorld(writableSink(writable), { onProgress }) }
  }
  const sink = blobSink()
  const result = await exportWorld(sink, { onProgress })
  const url = URL.createObjectURL(sink.blob())
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    document.body.append(a)
    a.click()
    a.remove()
  } finally {
    // Revoking at once can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return { method: 'download', result }
}

// ─── install prompt ────────────────────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredInstall: BeforeInstallPromptEvent | null = null
const installListeners = new Set<() => void>()
const notifyInstall = () => {
  for (const l of installListeners) l()
}

// Chrome fires beforeinstallprompt once, early, and only to listeners present at that
// moment, so capture it at module load and keep it for whoever asks later.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstall = e as BeforeInstallPromptEvent
    notifyInstall()
  })
  window.addEventListener('appinstalled', () => {
    deferredInstall = null
    notifyInstall()
  })
}

function subscribeInstall(cb: () => void): () => void {
  installListeners.add(cb)
  return () => installListeners.delete(cb)
}

/** Whether Chrome offered an install prompt, and a function to show it (needs a click). */
export function useInstallPrompt(): { canPrompt: boolean; prompt: () => Promise<'accepted' | 'dismissed' | 'unavailable'> } {
  const canPrompt = useSyncExternalStore(
    subscribeInstall,
    () => deferredInstall !== null,
    () => false,
  )
  return {
    canPrompt,
    prompt: async () => {
      const ev = deferredInstall
      if (!ev) return 'unavailable'
      // A prompt can be shown only once per event.
      deferredInstall = null
      notifyInstall()
      await ev.prompt()
      return (await ev.userChoice).outcome
    },
  }
}
