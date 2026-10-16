import { useApp } from '../app/store.ts'
import type { CameraMode } from '../app/store.ts'

// One-line key hint for the camera modes that take over the controls, so there is always a
// visible way out (Esc goes through useApp.escape in every one of them).

const HINTS: Partial<Record<CameraMode, string>> = {
  autonav: 'Riding the worldline · Esc exits',
  first_person: 'First person · WASD move · Q/E down/up · drag look · Esc exits',
  interior: 'Inside the memory · WASD move · Q/E down/up · Z/C roll · Esc flies out',
  third_person: 'Catwalk · W/S walk through time · A/D step onto a spur · O orbit',
}

export function ModeHint() {
  const mode = useApp((s) => s.mode)
  const hint = HINTS[mode]
  if (!hint) return null
  return (
    <div
      role="status"
      className="hud-label pointer-events-none absolute right-3 top-0 border border-bone/15 bg-void/70 px-2 py-1"
    >
      {hint}
    </div>
  )
}
