// Shared class strings for the editor controls. Brutalist: hard 1px edges, mono type, no
// radius, no shadow; keyboard focus is a hard signal-orange outline so it is never ambiguous.

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal'

export const INPUT =
  'w-full border border-bone/25 bg-void px-2 py-1.5 font-mono text-[12px] text-bone placeholder:text-concrete/60 ' +
  'focus:border-bone/60 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-signal ' +
  'disabled:opacity-40 aria-[invalid=true]:border-signal'

export const SELECT = `${INPUT} cursor-pointer appearance-none`

export const BTN = `hud-btn ${FOCUS}`

/** Primary / destructive emphasis. */
export const BTN_SIGNAL =
  `border border-signal bg-signal px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-void ` +
  `hover:bg-transparent hover:text-signal disabled:opacity-40 disabled:hover:bg-signal disabled:hover:text-void ${FOCUS}`

export const ERROR_TEXT = 'mt-1 font-mono text-[11px] text-signal'
export const HINT_TEXT = 'mt-1 font-mono text-[10px] text-concrete'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
