// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { useAuth } from '../../src/data/auth.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { importKnowledgeFiles, initializeKnowledge, resetKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import Workbench from '../../src/workspace/Workbench.tsx'
import { restoreWorkspaceContext, setWorkspaceQuery, useWorkspace, type WorkspaceSection } from '../../src/workspace/state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root

const button = (label: string) => {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`No button: ${label}`)
  return found
}

async function render(section: WorkspaceSection, hash = `#/${section}`) {
  location.hash = hash
  await act(async () => root.render(<Workbench section={section} hash={hash} />))
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(check(), host.textContent ?? 'No UI content').toBe(true)
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(input?: string) { return new Uint8Array(super.encode(input)) } })
  localStorage.clear()
  restoreWorkspaceContext()
  resetKnowledge()
  useAuth.setState({ state: 'none', user: null })
  useApp.getState().togglePanel('chat', false)
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  await closeRepo()
  resetKnowledge()
  useWorld.getState().hydrate(null, [])
  vi.unstubAllGlobals()
})

describe('readable knowledge workspace', () => {
  it('saves a plain thought and reads it without a model or a WebGL canvas', async () => {
    await render('today')
    const textarea = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => { setter.call(textarea, 'I chose local storage because original evidence should survive provider outages.'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('Save thought').click())
    await until(() => host.textContent?.includes('Saved to your record.') === true)
    expect(host.textContent).toContain('Saved to your record.')
    expect(host.querySelector('canvas')).toBeNull()
    expect(useWorld.getState().nodes.size).toBe(1)
    act(() => button('Read it').click())
    await render('library', location.hash)
    await until(() => host.querySelector('[aria-label="Document content"]')?.textContent?.includes('original evidence should survive provider outages') === true)
    expect(host.querySelector('.knowledge-reader-actions')?.textContent).toContain('Explore this record')
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('opens a searched conversation passage with authorship and exact source context', async () => {
    const json = JSON.stringify([{ uuid: 'conversation-one', name: 'Storage decision', chat_messages: [
      { uuid: 'human-turn', sender: 'human', text: 'Why should we retain a durable source ledger?', created_at: '2026-11-10T12:00:00Z' },
      { uuid: 'assistant-turn', sender: 'assistant', text: 'A durable source ledger preserves the original record and makes generated interpretations reviewable.', created_at: '2026-11-10T12:01:00Z' },
    ] }])
    await importKnowledgeFiles([new NodeFile([json], 'claude.json', { type: 'application/json' }) as unknown as File])
    await render('search')
    await act(async () => { setWorkspaceQuery('"generated interpretations reviewable"'); await new Promise((resolve) => setTimeout(resolve, 180)) })
    // The debounce is scheduled after the query render has committed.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)) })
    await until(() => host.querySelector('.knowledge-search-result') !== null)
    const result = host.querySelector<HTMLButtonElement>('.knowledge-search-result')
    expect(result?.textContent).toContain('Assistant')
    expect(result?.textContent).toContain('Storage decision')
    act(() => result!.click())
    const citation = useWorkspace.getState().selectedPassageId
    expect(citation).toBeTruthy()
    await render('library', location.hash)
    await until(() => host.querySelector('.knowledge-evidence blockquote') !== null)
    expect(host.querySelector('.knowledge-evidence blockquote')?.textContent).toBe('A durable source ledger preserves the original record and makes generated interpretations reviewable.')
    expect(host.querySelector('.knowledge-prose')?.textContent).toContain('Why should we retain a durable source ledger?')
    expect(host.querySelector('.knowledge-evidence')?.textContent).toContain('assistant')
  })

  it('removes excluded-source results immediately and keeps AI exclusion separate from local reading', async () => {
    await importKnowledgeFiles([new NodeFile(['The heliotrope decision was recorded in the original notebook.'], 'notes.md', { type: 'text/markdown' }) as unknown as File])
    const source = useKnowledge.getState().sources[0]
    await setSourcePolicy(source.id, { aiAllowed: false })
    await render('search')
    act(() => setWorkspaceQuery('heliotrope'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)) })
    await until(() => host.querySelector('.knowledge-search-result') !== null)
    expect(host.querySelector('.knowledge-search-result')?.textContent).toContain('heliotrope')
    await act(async () => { await setSourcePolicy(source.id, { excluded: true }) })
    expect(host.querySelector('.knowledge-search-result')).toBeNull()
    await render('library', `#/library?source=${source.id}`)
    expect(host.textContent).toContain('This source is excluded')
    expect(host.querySelector('.knowledge-prose')).toBeNull()
  })

  it('reopens an earlier cited passage after the same source receives a new version', async () => {
    await importKnowledgeFiles([new NodeFile(['The original decision was to keep a recoverable source ledger.'], 'decision.md', { type: 'text/markdown' }) as unknown as File])
    const passage = useKnowledge.getState().passages[0]
    await importKnowledgeFiles([new NodeFile(['The revised decision adds verified restore checks to the source ledger.'], 'decision.md', { type: 'text/markdown' }) as unknown as File])
    await render('library', `#/library?passage=${passage.id}`)
    await until(() => host.querySelector('.knowledge-evidence blockquote') !== null)
    expect(host.querySelector('.knowledge-evidence blockquote')?.textContent).toBe('The original decision was to keep a recoverable source ledger.')
    expect(host.textContent).toContain('earlier retained source version')
    expect(host.querySelector('.knowledge-prose')?.textContent).not.toContain('revised decision adds')
  })
})

it('opens the current version only when explicitly requested after a pinned quote version disappears', async () => {
  const words = 'The current document wording.'
  await importKnowledgeFiles([new NodeFile([words], 'version.md', { type: 'text/markdown' }) as unknown as File])
  const source = useKnowledge.getState().sources[0]
  await render('library', '#/library?source=' + source.id + '&version=gone')
  const reader = host.querySelector('[aria-label="Requested source version unavailable"]')!
  expect(reader.textContent).toContain('This retained version is unavailable')
  expect(reader.textContent).not.toContain(words)
  const link = reader.querySelector<HTMLAnchorElement>('a')!
  expect(link.textContent).toBe('Read current version')
  await render('library', link.hash)
  await until(() => host.querySelector('[aria-label="Document content"]')?.textContent?.includes(words) === true)
})
