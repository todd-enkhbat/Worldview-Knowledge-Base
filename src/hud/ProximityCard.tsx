import { useApp, useWorld } from '../app/store.ts'
import type { CameraMode } from '../app/store.ts'
import { formatByPrecision } from '../domain/time.ts'
import { useProximity } from '../world/camera/proximity.ts'
import { NodeGlyph } from './Inspector.tsx'

// Small metadata card for the node nearest the viewer's focus point, shown while nothing is
// selected. useProximity only publishes when the nearest node changes, so this re-renders
// on a new node, not per frame.

const SHOW_IN: readonly CameraMode[] = ['orbit', 'third_person', 'first_person', 'autonav']

export function ProximityCard() {
  const nearestId = useProximity((s) => s.nearestId)
  const node = useWorld((s) => (nearestId ? s.nodes.get(nearestId) : undefined))
  const selectedId = useApp((s) => s.selectedId)
  const mode = useApp((s) => s.mode)
  const libraryOpen = useApp((s) => s.panels.library)
  // The demon panel docks in the same column and runs to the bottom edge.
  const demonsOpen = useApp((s) => s.panels.demons)

  if (!node || selectedId || demonsOpen || !SHOW_IN.includes(mode)) return null
  const ref = node.referenceDate

  return (
    <button
      type="button"
      onClick={() => useApp.getState().select(node.id)}
      aria-label={`Nearby: ${node.title}, ${node.archetype}. Inspect.`}
      // Sits beside the Library rather than under it.
      className={`hud-panel absolute bottom-3 block w-[min(18rem,calc(100%-1.5rem))] px-3 py-2 text-left hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-bone/60 focus-visible:outline-2 focus-visible:outline-signal ${
        libraryOpen ? 'left-3 sm:left-[calc(min(20rem,100%-1.5rem)+1.5rem)]' : 'left-3'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="hud-label">Nearby</span>
        <NodeGlyph archetype={node.archetype} />
        <span className="hud-label">{node.archetype}</span>
      </span>
      <span className="mt-1 block truncate text-[13px] text-bone">{node.title}</span>
      <span className="mt-0.5 block text-[11px] text-concrete">
        {formatByPrecision(node.temporalOrigin, node.temporalPrecision)}
        {ref && ` · ref ${formatByPrecision(ref.epochMs, ref.precision)}`}
      </span>
    </button>
  )
}
