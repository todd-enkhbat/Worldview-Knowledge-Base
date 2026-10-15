import { useApp, useWorld } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { StorageBadge } from './StorageBadge.tsx'
import { MOD_KEY, openPalette, openPicker } from './shortcuts.ts'

// Brand, camera mode, node count, storage badge and the main entry points. The bar itself
// lets clicks through to the world; only its panels take the pointer.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal'
const BTN = `hud-btn ${FOCUS}`

export function TopBar() {
  const mode = useApp((s) => s.mode)
  const libraryOpen = useApp((s) => s.panels.library)
  const demonsOpen = useApp((s) => s.panels.demons)
  const count = useWorld((s) => s.nodes.size)
  const writer = useRepoStatus((s) => s.writer)

  return (
    <header className="pointer-events-none flex items-stretch gap-2">
      <div className="hud-panel flex h-10 items-center gap-3 px-3">
        <span aria-hidden="true" className="text-[14px] leading-none text-signal">
          ▚
        </span>
        <h1 className="m-0 hidden text-[11px] font-bold uppercase tracking-[0.28em] text-bone md:block">Architectural Hyperspace</h1>
      </div>

      <dl className="hud-panel m-0 hidden h-10 items-center gap-3 px-3 sm:flex">
        <dt className="hud-label">Mode</dt>
        <dd className="m-0 uppercase tracking-wider" aria-live="polite">
          {mode.replace('_', ' ')}
        </dd>
        <dt className="hud-label ml-2">Nodes</dt>
        <dd className="m-0 tabular-nums">{count}</dd>
      </dl>

      <div className="flex-1" />

      <div className="hud-panel flex h-10 items-center px-2">
        <StorageBadge />
      </div>

      <nav aria-label="HUD" className="hud-panel flex h-10 items-center gap-1 px-1">
        <button
          type="button"
          className={BTN}
          disabled={!writer}
          title={writer ? 'New node (N)' : 'Read-only: another tab is the writer'}
          aria-keyshortcuts="N"
          onClick={openPicker}
        >
          + New
        </button>
        <button
          type="button"
          // Pressed state as an underline: .hud-btn's colours are unlayered and beat utilities.
          className={`${BTN} decoration-signal decoration-2 underline-offset-4 aria-pressed:underline`}
          aria-pressed={libraryOpen}
          aria-keyshortcuts="L"
          title="Library (L)"
          onClick={() => useApp.getState().togglePanel('library')}
        >
          Library
        </button>
        <button
          type="button"
          className={`${BTN} decoration-signal decoration-2 underline-offset-4 aria-pressed:underline`}
          aria-pressed={demonsOpen}
          title="Demons and the Landauer ledger"
          onClick={() => useApp.getState().togglePanel('demons')}
        >
          Demons
        </button>
        <button type="button" className={BTN} aria-keyshortcuts="," title="Settings (,)" onClick={() => useApp.getState().togglePanel('settings', true)}>
          Settings
        </button>
        <button
          type="button"
          className={BTN}
          aria-label="Command palette"
          aria-keyshortcuts="Meta+K Control+K"
          title={`Command palette (${MOD_KEY}K)`}
          onClick={() => openPalette()}
        >
          <kbd className="font-mono">{MOD_KEY}K</kbd>
        </button>
      </nav>
    </header>
  )
}
