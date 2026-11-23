// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { useApp, useWorld } from '../../src/app/store.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { flyTo } from '../../src/world/camera/flyTo.ts'
import ExploreBridge from '../../src/workspace/ExploreBridge.tsx'

vi.mock('../../src/world/camera/flyTo.ts', () => ({ flyTo: vi.fn(() => true), getOrbitControls: () => ({}) }))
vi.mock('../../src/world/poses.ts', () => ({ getPoseTable: () => ({ index: new Map([['reader-note', 0]]) }) }))
vi.mock('../../src/world/time/clock.ts', () => ({ ensurePlayhead: () => 18000, seekPlayhead: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('opens a linked record after a previous canvas was left in a protected interior mode', async () => {
  const now = Date.now()
  const settings: WorldSettings = { T0: now - 30 * MS_PER_YEAR, yPerYear: 12, stepsPerYear: 600, physicsSeed: 1, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: now, schemaVersion: 1 }
  const node = makeNodeDraft('idea', { id: 'reader-note', title: 'Reader evidence', temporalOrigin: now })
  useWorld.getState().hydrate(settings, [node])
  useApp.setState({ mode: 'interior', prevMode: 'entering', focusedId: 'old-memory' })
  const callbacks: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ExploreBridge hash="#/explore?record=reader-note" />))
    expect(useApp.getState().mode).toBe('orbit')
    expect(useApp.getState().focusedId).toBeNull()
    act(() => callbacks.shift()?.(0))
    expect(flyTo).toHaveBeenCalledWith('reader-note', { distance: 32 })
    expect(useApp.getState().selectedId).toBe('reader-note')
    expect(useWorld.getState().nodes.get('reader-note')).toEqual(node)
  } finally { act(() => root.unmount()); host.remove(); useWorld.getState().hydrate(null, []); useApp.setState({ mode: 'orbit', focusedId: null }); vi.unstubAllGlobals() }
})
