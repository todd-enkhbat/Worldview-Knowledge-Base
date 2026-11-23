import { useEffect, useRef } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { flyTo, getOrbitControls } from '../world/camera/flyTo.ts'
import { getPoseTable } from '../world/poses.ts'
import { ensurePlayhead, seekPlayhead } from '../world/time/clock.ts'
import { historyStepForRecord } from './history.ts'

/** Wait for the new canvas's controls/poses before focusing a record from the reader. */
export default function ExploreBridge({ hash }: { hash: string }) {
  const ready = useWorld((s) => s.loaded && s.settings?.firstRunComplete === true)
  const nodes = useWorld((s) => s.nodes)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const id = new URLSearchParams(hash.split('?')[1] ?? '').get('record')
    const node = id ? nodes.get(id) : null
    if (!ready || !id || !node || handled.current === id) return
    const settings = useWorld.getState().settings!
    const app = useApp.getState()
    // This is a new canvas reached from a record link; an old walk/flight/interior rig
    // must not prevent its orbit controls from mounting. In-canvas handoffs keep their guards.
    if (app.mode !== 'orbit' && !app.setMode('orbit')) useApp.setState({ mode: 'orbit', prevMode: 'orbit' })
    app.focus(null)
    let frame = 0
    let attempts = 0
    const focus = () => {
      if (getOrbitControls() && getPoseTable().index.has(id)) {
        // Initialize the shared clock first: its first canvas frame must not undo a seek
        // requested from the reader. Births use the shared integer mapping, without ceil.
        const now = Date.now()
        const current = ensurePlayhead(settings, now)
        const target = historyStepForRecord(current, node.temporalOrigin, settings, now)
        if (target !== current) { useApp.getState().setClock({ playing: false }); seekPlayhead(target) }
      }
      if (getOrbitControls() && getPoseTable().index.has(id) && flyTo(id, { distance: 32 })) {
        useApp.getState().select(id)
        handled.current = id
      } else if (++attempts < 300) frame = requestAnimationFrame(focus)
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [ready, hash, nodes])
  return null
}
