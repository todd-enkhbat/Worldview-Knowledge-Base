import { useApp, useWorld } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { STORAGE_EXPLAIN, STORAGE_LABEL, storageKind } from './durability.ts'
import type { StorageKind } from './durability.ts'
import { FOCUS } from './DurabilityKit.tsx'

const TONE: Readonly<Record<StorageKind, string>> = {
  persisted: 'border-glass/50 text-glass',
  'best-effort': 'border-ember/60 text-ember',
  memory: 'border-signal bg-signal text-void',
  unknown: 'border-bone/30 text-concrete',
}

const DOT: Readonly<Record<StorageKind, string>> = {
  persisted: 'bg-glass',
  'best-effort': 'bg-ember',
  memory: 'bg-void',
  unknown: 'bg-concrete',
}

export interface StorageBadgeProps {
  /** Default: open Settings (where the storage section explains the badge). */
  onClick?: () => void
  className?: string
}

/** Tiny persistent top-bar badge: PERSISTED / BEST-EFFORT / MEMORY. */
export function StorageBadge({ onClick, className = '' }: StorageBadgeProps) {
  const fallback = useRepoStatus((s) => s.fallback)
  const persisted = useWorld((s) => s.storage.persisted)
  const kind = storageKind({ fallback, persisted })
  const label = STORAGE_LABEL[kind]
  return (
    <button
      type="button"
      onClick={onClick ?? (() => useApp.getState().togglePanel('settings', true))}
      title={STORAGE_EXPLAIN[kind]}
      aria-label={`Storage: ${label.toLowerCase()}. ${STORAGE_EXPLAIN[kind]} Open settings.`}
      className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.14em] hover:bg-bone hover:text-void ${TONE[kind]} ${FOCUS} ${className}`}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 ${DOT[kind]}`} />
      {label}
    </button>
  )
}
