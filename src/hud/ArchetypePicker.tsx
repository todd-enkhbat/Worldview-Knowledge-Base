import { useEffect, useRef } from 'react'
import { useApp } from '../app/store.ts'
import { ARCHETYPES, type Archetype } from '../domain/types.ts'
import { isTypingTarget, trapTab } from './fields/focus.ts'
import { FOCUS } from './fields/ui.ts'

export interface ArchetypeInfo {
  name: string
  /** What it is for, in one line. */
  description: string
  /** Its 3D form in the world. */
  form: string
}

export const ARCHETYPE_INFO: Readonly<Record<Archetype, ArchetypeInfo>> = {
  idea: { name: 'Idea', description: 'a concept, belief or open question', form: 'a faceted crystal' },
  entity: { name: 'Entity', description: 'a person, place, organisation or work that exerts pull', form: 'an obsidian monolith' },
  lens: { name: 'Lens', description: 'a framework or way of seeing', form: 'a brass astrolabe' },
  document: { name: 'Document', description: 'a text, note or source', form: 'a concrete slab' },
  memory: { name: 'Memory', description: 'a lived moment; can hold a volumetric scene', form: 'a tesseract' },
  demon: { name: 'Demon', description: 'a standing query that sorts what matches', form: "Maxwell's demon" },
}

const TICKS = Array.from({ length: 12 }, (_, k) => {
  const a = (k / 12) * Math.PI * 2
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x1: 24 + c * 15.5, y1: 25 + s * 15.5, x2: 24 + c * 18, y2: 25 + s * 18 }
})

/** Line glyph echoing each archetype's 3D form. Decorative: always pair it with a text name. */
export function ArchetypeGlyph({ archetype, className = 'h-10 w-10' }: { archetype: Archetype; className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="miter"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      {archetype === 'idea' && (
        <>
          <path d="M24 3 L28 18 L24 45 Z" fill="currentColor" fillOpacity={0.18} stroke="none" />
          <path d="M24 3 L35 18 L24 45 L13 18 Z" />
          <path d="M13 18 L35 18 M24 3 L20 18 L24 45 M24 3 L28 18 L24 45" strokeWidth={1} />
        </>
      )}
      {archetype === 'entity' && (
        <>
          <path d="M28 6 L33 3 L33 40 L28 43 Z" fill="currentColor" fillOpacity={0.35} />
          <path d="M15 6 L28 6 L28 43 L15 43 Z" fill="currentColor" fillOpacity={0.12} />
          <path d="M15 6 L20 3 L33 3 L28 6" />
          <path d="M8 45 L40 45" strokeWidth={1} />
          <path d="M3 24 L10 24 M7 21 L10 24 L7 27 M45 32 L37 32 M40 29 L37 32 L40 35" strokeWidth={1} />
        </>
      )}
      {archetype === 'lens' && (
        <>
          <circle cx={24} cy={3.5} r={2} strokeWidth={1} />
          <circle cx={24} cy={25} r={18} />
          <circle cx={24} cy={25} r={11} strokeWidth={1} />
          <ellipse cx={24} cy={25} rx={18} ry={6.5} transform="rotate(-24 24 25)" strokeWidth={1} />
          {TICKS.map((t, k) => (
            <line key={k} {...t} strokeWidth={1} />
          ))}
          <path d="M9 33 L39 17" />
          <circle cx={24} cy={25} r={1.6} fill="currentColor" stroke="none" />
        </>
      )}
      {archetype === 'document' && (
        <>
          <path d="M6 33 L14 15 L44 15 L36 33 Z" fill="currentColor" fillOpacity={0.12} />
          <path d="M6 33 L36 33 L36 39 L6 39 Z" />
          <path d="M36 33 L44 15 L44 21 L36 39" />
          <path d="M15 20 L35 20 M13 24.5 L30 24.5 M11 29 L33 29" strokeWidth={1} />
        </>
      )}
      {archetype === 'memory' && (
        <>
          <rect x={16} y={16} width={16} height={16} fill="currentColor" fillOpacity={0.18} strokeWidth={1} />
          <rect x={6} y={6} width={36} height={36} />
          <path d="M6 6 L16 16 M42 6 L32 16 M6 42 L16 32 M42 42 L32 32" strokeWidth={1} />
        </>
      )}
      {archetype === 'demon' && (
        <>
          <rect x={4} y={15} width={40} height={27} />
          <path d="M24 15 L24 24 M24 33 L24 42" />
          <path d="M24 24 L29 21" strokeWidth={1} />
          <circle cx={24} cy={9} r={3} />
          <path d="M21.6 7.4 L20.5 3 L23 6.2 M26.4 7.4 L27.5 3 L25 6.2" strokeWidth={1} />
          <path d="M15 28.5 L31 28.5 M28 26 L31 28.5 L28 31" strokeWidth={1} />
          <circle cx={10} cy={21} r={1.6} strokeWidth={1} />
          <circle cx={13} cy={36} r={1.6} strokeWidth={1} />
          <circle cx={34} cy={21} r={1.7} fill="currentColor" stroke="none" />
          <circle cx={39} cy={35} r={1.7} fill="currentColor" stroke="none" />
          <circle cx={33} cy={37} r={1.7} fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

function choose(archetype: Archetype) {
  const app = useApp.getState()
  app.togglePanel('picker', false)
  app.openEditor({ nodeId: null, archetype })
}

/** "New node" chooser: six tiles, keys 1–6 pick, Esc closes. Shown while panels.picker is open. */
export function ArchetypePicker() {
  const open = useApp((s) => s.panels.picker)
  return open ? <PickerDialog /> : null
}

function PickerDialog() {
  const dialogRef = useRef<HTMLDivElement>(null)
  const chosen = useRef(false)

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Capture phase so the digits never reach the camera rig's own key bindings.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTypingTarget(e.target)) return
      const k = /^[1-9]$/.test(e.key) ? Number(e.key) : 0
      if (k >= 1 && k <= ARCHETYPES.length) {
        e.preventDefault()
        e.stopPropagation()
        chosen.current = true
        choose(ARCHETYPES[k - 1])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      // Hand focus back only on a plain close; after a choice the editor's title owns it.
      if (!chosen.current && prev?.isConnected) prev.focus()
    }
  }, [])

  const close = () => useApp.getState().togglePanel('picker', false)

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-void/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archetype-picker-title"
        aria-describedby="archetype-picker-help"
        className="hud-panel max-h-full w-full max-w-[46rem] overflow-y-auto p-6"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            useApp.getState().escape()
          } else trapTab(e, dialogRef.current)
        }}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="hud-label">New node</p>
            <h2 id="archetype-picker-title" className="mt-1 font-mono text-[18px] font-bold uppercase tracking-[0.06em] text-bone">
              Choose an archetype
            </h2>
            <p id="archetype-picker-help" className="mt-1 font-mono text-[11px] text-concrete">
              Press 1–6 or pick a tile. Esc closes.
            </p>
          </div>
          <button type="button" className={`hud-btn ${FOCUS}`} onClick={close} aria-label="Close archetype picker">
            Esc
          </button>
        </div>

        <ul className="grid grid-cols-1 gap-px border border-bone/20 bg-bone/20 sm:grid-cols-2 md:grid-cols-3">
          {ARCHETYPES.map((a, i) => {
            const info = ARCHETYPE_INFO[a]
            return (
              <li key={a} className="bg-void">
                <button
                  type="button"
                  autoFocus={i === 0}
                  aria-keyshortcuts={String(i + 1)}
                  aria-label={`${info.name}: ${info.description}. ${info.form}. Shortcut ${i + 1}`}
                  className={`group relative flex h-full w-full flex-col items-start gap-3 p-4 text-left text-bone hover:bg-bone/[0.06] focus-visible:bg-bone/[0.06] ${FOCUS} focus-visible:outline-offset-[-2px]`}
                  onClick={() => {
                    chosen.current = true
                    choose(a)
                  }}
                >
                  <span className="absolute top-2 right-2 border border-signal/70 px-1 font-mono text-[10px] text-signal group-hover:bg-signal group-hover:text-void">
                    {i + 1}
                  </span>
                  <ArchetypeGlyph archetype={a} className="h-12 w-12 text-bone group-hover:text-ember" />
                  <span className="flex flex-col gap-1">
                    <span className="font-mono text-[13px] font-bold uppercase tracking-[0.12em]">{info.name}</span>
                    <span className="font-mono text-[11px] leading-snug text-concrete">{info.description}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-brass">{info.form}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
