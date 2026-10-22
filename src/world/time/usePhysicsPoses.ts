import { useFrame } from '@react-three/fiber'
import { useEffect } from 'react'
import { useApp, useWorld } from '../../app/store.ts'
import { updateField } from '../field/runtime.ts'
import { getPlayhead, playheadEpoch } from './clock.ts'
import { applyOverlays } from './overlayHook.ts'
import { getPhysicsClient } from './physicsClient.ts'
import { PoseWriter } from './poseWriter.ts'

// The Phase-3 pose writer (replaces usePoseWriterStatic in the Scene). Each frame, after
// the clock (priority −3) has moved the playhead: send the target step to the worker,
// take its newest frame and write render poses = O(P(n) + acc·D, t). Until the first
// frame arrives, and for good when workers are unavailable or the worker fails, the
// static anchors stand in (with ghosts for records born after the playhead).

const writer = new PoseWriter()

export function usePhysicsPoses(): void {
  useEffect(() => {
    const client = getPhysicsClient()
    client.start()
    return () => client.stop()
  }, [])

  useFrame((state) => {
    const client = getPhysicsClient()
    const ph = getPlayhead()
    client.sendTarget(ph.step)
    // The particle world writes its own poses (a pure function of the playhead); the engine
    // keeps running for the timeline's readouts.
    if (useApp.getState().view.world === 'field') {
      client.acquire()
      const w = useWorld.getState()
      if (w.settings) updateField(w.nodes, w.settings, playheadEpoch(w.settings), state.clock.elapsedTime)
      return
    }
    const frame = client.acquire()
    let table
    if (frame) table = writer.writePhysics(frame, ph.step, ph.acc)
    else {
      const w = useWorld.getState()
      table = writer.writeStatic(w.nodes, w.settings, w.revision, ph.step)
    }
    applyOverlays(table, Date.now())
  }, -2)
}
