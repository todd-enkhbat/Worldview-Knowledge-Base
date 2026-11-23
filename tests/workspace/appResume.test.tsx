// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAuth } from '../../src/data/auth.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { flushWorkspacePersistence } from '../../src/workspace/persistence.ts'
import { restoreWorkspaceContext, useWorkspace, validateWorkspaceContext } from '../../src/workspace/state.ts'
import App from '../../src/App.tsx'

vi.mock('../../src/world/WorldPage.tsx', async () => {
  const { returnToWorkspace } = await import('../../src/workspace/state.ts')
  return { default: () => <button onClick={returnToWorkspace}>Return from Explore</button> }
})
vi.mock('../../src/workspace/ExploreBridge.tsx', () => ({ default: () => null }))
vi.mock('../../src/workspace/Workbench.tsx', () => ({ default: () => <main>Readable workspace</main> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('restores the last cited investigation before returning from a directly reloaded Explore route', async () => {
  localStorage.clear()
  restoreWorkspaceContext('other-scope')
  useAuth.setState({ state: 'none', user: null })
  const context = validateWorkspaceContext({ returnHash: '#/library?passage=retained-quote', selectedPassageId: 'retained-quote', sourceIds: ['source-one'], query: 'Last investigation', lastSection: 'library', readerPositions: { 'retained-quote': 430 } })
  localStorage.setItem('worldview.workspace.v1:local', JSON.stringify(context))
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  history.replaceState(null, '', '/#/explore?record=reader-note')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<App />))
    const button = host.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toBe('Return from Explore')
    expect(useWorkspace.getState()).toMatchObject({ selectedPassageId: 'retained-quote', query: 'Last investigation', sourceIds: ['source-one'] })
    act(() => button!.click())
    expect(location.hash).toBe('#/library?passage=retained-quote')
    expect(useWorkspace.getState().readerPositions['retained-quote']).toBe(430)
    await flushWorkspacePersistence()
  } finally { act(() => root.unmount()); host.remove(); await closeRepo() }
})
