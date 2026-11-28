// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { captureThought, initializeKnowledge, resetKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import { createKnowledgePage, initializeArtifacts, resetArtifacts, runArtifactJobs, useArtifacts } from '../../src/knowledge/artifacts/index.ts'
import KnowledgePages from '../../src/workspace/KnowledgePages.tsx'
import { projectDecisionsHref } from '../../src/workspace/routes.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(input?: string) { return new Uint8Array(super.encode(input)) } })
  resetArtifacts(); resetKnowledge()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge(); await initializeArtifacts()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetArtifacts(); resetKnowledge(); await closeRepo(); vi.unstubAllGlobals() })
function button(text: string, prefix = false): HTMLButtonElement {
  const result = [...host.querySelectorAll('button')].find((item) => prefix ? item.textContent?.trim().startsWith(text) : item.textContent?.trim() === text)
  if (!result) throw new Error(`No button ${text}: ${host.textContent}`)
  return result
}
function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const field = [...host.querySelectorAll('label')].find((item) => item.textContent?.trim().startsWith(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  if (!field) throw new Error(`No field ${label}`)
  return field
}
function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(check(), host.textContent ?? 'No content').toBe(true)
}
async function createFromSource() {
  await captureThought('The amber lighthouse launch is approved after the budget review.')
  await act(async () => root.render(<KnowledgePages hash="#/knowledge" />))
  act(() => button('New page').click())
  fill(input('Page title'), 'Amber launch investigation')
  const checkbox = host.querySelector<HTMLInputElement>('.maintained-source-options input')!
  act(() => checkbox.click())
  await act(async () => host.querySelector('.maintained-create')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await act(async () => runArtifactJobs())
  await until(() => useArtifacts.getState().pageRevisions.length === 1)
}

it('creates, reviews, corrects and archives/restores a source-backed page through the real UI', async () => {
  await createFromSource()
  expect(host.querySelector('canvas')).toBeNull()
  expect(host.textContent).toContain('No accepted wording yet')
  act(() => button('Review (', true).click())
  expect(host.querySelector('.maintained-diff')?.textContent).toContain('Proposed wording')
  expect(host.querySelector('.maintained-evidence a')?.getAttribute('href')).toMatch(/^#\/library\?passage=/)
  await act(async () => button('Accept page revision').click())
  await until(() => useArtifacts.getState().pages[0].currentRevisionId !== null)
  await act(async () => button('Accept statement').click())
  await until(() => useArtifacts.getState().claims.some((claim) => claim.currentRevisionId !== null))
  act(() => button('Read').click())
  expect(host.querySelector('.maintained-body')?.textContent).toContain('budget review')
  expect(host.querySelector('.maintained-claims')?.textContent).toContain('Attributed to human')
  act(() => button('Edit your wording').click())
  fill(input('Your maintained wording'), 'My correction: the launch is approved; the explanation remains provisional.')
  await act(async () => button('Save wording').click())
  await until(() => host.querySelector('.maintained-body')?.textContent?.includes('My correction') === true)
  await act(async () => button('Archive').click())
  await until(() => host.textContent?.includes('This page is archived') === true)
  await act(async () => button('Restore page').click())
  await until(() => host.querySelector('.maintained-body')?.textContent?.includes('My correction') === true)
  expect(useKnowledge.getState().versions[0].text).not.toContain('My correction')
})

it('hides accepted derived text and retained history when its source becomes excluded', async () => {
  await createFromSource()
  act(() => button('Review (', true).click())
  await act(async () => button('Accept page revision').click())
  await until(() => useArtifacts.getState().pages[0].currentRevisionId !== null)
  act(() => button('Read').click())
  expect(host.querySelector('.maintained-body')?.textContent).toContain('budget review')
  const sourceId = useKnowledge.getState().sources[0].id
  await act(async () => setSourcePolicy(sourceId, { excluded: true }))
  await until(() => host.textContent?.includes('Derived wording and history are hidden') === true)
  expect(host.querySelector('.maintained-body')?.textContent).not.toContain('budget review')
  act(() => button('History & dates').click())
  expect(host.querySelector('.maintained-history-body')).toBeNull()
  expect(host.querySelector('canvas')).toBeNull()
})

it('opens project decision history directly and records manual wording for review', async () => {
  const page = await createKnowledgePage({ title: 'Pilot decisions', kind: 'project' })
  await act(async () => root.render(<KnowledgePages hash={projectDecisionsHref(page.id)} />))
  expect(button('Decisions').getAttribute('aria-pressed')).toBe('true')
  act(() => button('Record a decision').click())
  fill(input('Decision wording'), 'Measure the trial before expanding it.')
  await act(async () => button('Save proposed decision').click())
  await until(() => host.textContent?.includes('Proposed decision') === true)
  await act(async () => button('Accept decision').click())
  await until(() => useArtifacts.getState().claimRevisions[0]?.status === 'accepted')
  act(() => button('Decisions').click())
  expect(host.querySelector('.maintained-timeline')?.textContent).toContain('Measure the trial before expanding it.')
  expect(host.querySelector('.maintained-decision-state')?.textContent).toContain('Current')
})
