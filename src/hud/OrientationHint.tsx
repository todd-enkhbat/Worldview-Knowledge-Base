import { useEffect, useState } from 'react'
import { useApp, useWorld } from '../app/store.ts'

// One line on a first visit that says how to read the world, centred at the top of the stage.
// It goes on the first interaction (a click, drag, wheel or key) and never comes back on this
// device. Hidden while a camera mode shows its own key hint (ModeHint).

const KEY = 'hyperspace.oriented'
const TEXT = 'XYZ is space · timeline is history · select a note to read it'

function seen(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function OrientationHint() {
  const [show, setShow] = useState(() => !seen())
  const hasNodes = useWorld((s) => s.nodes.size > 0)
  const orbit = useApp((s) => s.mode === 'orbit')

  useEffect(() => {
    if (!show || !hasNodes) return
    const dismiss = () => {
      setShow(false)
      try {
        globalThis.localStorage?.setItem(KEY, '1')
      } catch {
        // Storage blocked: it shows again next visit, which is harmless.
      }
    }
    const opts = { capture: true, once: true } as const
    window.addEventListener('pointerdown', dismiss, opts)
    window.addEventListener('wheel', dismiss, opts)
    window.addEventListener('keydown', dismiss, opts)
    return () => {
      window.removeEventListener('pointerdown', dismiss, opts)
      window.removeEventListener('wheel', dismiss, opts)
      window.removeEventListener('keydown', dismiss, opts)
    }
  }, [show, hasNodes])

  if (!show || !hasNodes || !orbit) return null
  return (
    <div
      role="status"
      data-label-avoid
      className="hud-label pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap border border-ember/40 bg-void/80 px-3 py-1.5 text-[11px] text-bone"
    >
      {TEXT}
    </div>
  )
}
