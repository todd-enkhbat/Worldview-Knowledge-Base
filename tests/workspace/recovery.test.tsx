// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExploreBoundary } from '../../src/workspace/ExploreBoundary.tsx'
import { restoreWorkspaceContext, useWorkspace } from '../../src/workspace/state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps a renderer crash from removing the return path to the saved investigation', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  localStorage.clear()
  restoreWorkspaceContext('recovery-test')
  useWorkspace.setState({ query: 'Find the evidence', sourceIds: ['source-one'], returnHash: '#/library?passage=evidence-one', readerPositions: { 'evidence-one': 500 } })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  function BrokenWorld(): never { throw new Error('Renderer unavailable') }
  try {
    await act(async () => root.render(<ExploreBoundary><BrokenWorld /></ExploreBoundary>))
    expect(host.querySelector('[role=alert]')?.textContent).toContain('The 3D view couldn’t open.')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('#/library?passage=evidence-one')
    expect(useWorkspace.getState()).toMatchObject({ query: 'Find the evidence', sourceIds: ['source-one'], readerPositions: { 'evidence-one': 500 } })
  } finally { act(() => root.unmount()); host.remove(); log.mockRestore() }
})
