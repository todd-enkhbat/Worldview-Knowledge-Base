// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { useAuth } from '../../src/data/auth.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { useKnowledge } from '../../src/knowledge/index.ts'
import type { KnowledgeSource } from '../../src/knowledge/types.ts'
import { CommandMenu, openCommandMenu } from '../../src/workspace/CommandMenu.tsx'
import { restoreWorkspaceContext, useWorkspace } from '../../src/workspace/state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let opener: HTMLButtonElement

const node = (id: string, title: string, extra: Partial<NodeRecord> = {}): NodeRecord => ({
  id, title, slug: id, archetype: 'idea', contentMd: 'secret body-only phrase', tags: ['architecture'],
  temporalOrigin: 0, temporalPrecision: 'day', referenceDate: null, thermo: { mass: 1, temperature: 1 }, anchorXZ: [0, 0], links: [], attachments: [], visibility: 'private', createdAt: 1, updatedAt: 2, deletedAt: null, schemaVersion: 1, ...extra,
})
const source = (id: string, title: string, extra: Partial<KnowledgeSource> = {}): KnowledgeSource => ({ id, title, kind: 'document', externalId: id, currentVersionId: `${id}-version`, createdAt: 1, updatedAt: 3, tags: ['budget'], excluded: false, aiAllowed: false, ...extra })
const menu = () => host.querySelector<HTMLDialogElement>('dialog')
const input = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')]
const current = () => document.getElementById(input().getAttribute('aria-activedescendant')!)

function key(target: EventTarget, value: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })
  act(() => { target.dispatchEvent(event) })
  return event
}
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => {
  // jsdom does not implement dialog's top layer. These shims only supply lifecycle;
  // input/arrow/Tab/restore behavior below is exercised through the real component.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(async () => {
  location.hash = '#/today'
  localStorage.clear()
  restoreWorkspaceContext()
  useWorld.getState().hydrate(null, [])
  useKnowledge.setState({ sources: [], loaded: true })
  useAuth.setState({ user: null, state: 'none' })
  for (const panel of Object.keys(useApp.getState().panels) as (keyof ReturnType<typeof useApp.getState>['panels'])[]) useApp.getState().togglePanel(panel, false)
  useApp.getState().closeEditor()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Command search must not call an API') }))
  host = document.createElement('div')
  opener = document.createElement('button')
  opener.textContent = 'Open commands'
  document.body.append(opener, host)
  opener.focus()
  root = createRoot(host)
  await act(async () => root.render(<CommandMenu />))
  // Flush hash events from the test's route setup before opening the menu.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  opener.remove()
  vi.unstubAllGlobals()
})

describe('workspace command menu', () => {
  it('opens with either platform shortcut and navigates with arrows and Enter', () => {
    expect(key(window, 'k', { metaKey: true }).defaultPrevented).toBe(true)
    expect(menu()?.open).toBe(true)
    expect(document.activeElement).toBe(input())
    expect(current()?.textContent).toContain('Capture a thought')
    type('library')
    expect(current()?.textContent).toContain('Library')
    key(input(), 'Enter')
    expect(location.hash).toBe('#/library')
    expect(menu()).toBeNull()
    key(window, 'k', { ctrlKey: true })
    key(input(), 'ArrowDown')
    expect(current()?.textContent).toContain('Today')
    key(input(), 'ArrowUp')
    expect(current()?.textContent).toContain('Capture a thought')
    key(window, 'k', { ctrlKey: true })
    expect(menu()).toBeNull()
  })

  it('traps Tab within the menu and restores focus after Escape', () => {
    act(() => openCommandMenu())
    key(input(), 'Tab', { shiftKey: true })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close command menu')
    key(document.activeElement!, 'Tab')
    expect(document.activeElement).toBe(input())
    key(input(), 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('clears an empty-result search and resets the selected command', () => {
    act(() => openCommandMenu())
    type('nothing-matches-this')
    expect(host.textContent).toContain('No matching commands or records')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Clear command search"]')!.click())
    expect(input().value).toBe('')
    expect(document.activeElement).toBe(input())
    expect(current()?.textContent).toContain('Capture a thought')
    expect(host.textContent).not.toContain('No matching commands or records')
    type('review')
    expect(current()?.textContent).toContain('Review')
    type('library')
    expect(current()?.textContent).toContain('Library')
  })

  it('searches canonical source metadata locally, includes AI-disabled sources, and bounds results', () => {
    useKnowledge.setState({ sources: [source('src', 'Auróra planning', { nodeId: 'projection', updatedAt: 100 })] })
    useWorld.getState().hydrate(null, [node('projection', 'Auróra planning'), ...Array.from({ length: 20 }, (_, i) => node(`item-${i}`, `Aurora ${i}`, { updatedAt: i }))])
    act(() => openCommandMenu())
    type('aurora')
    expect(options()).toHaveLength(8)
    expect(options().filter((entry) => entry.textContent?.includes('Auróra planning'))).toHaveLength(1)
    type('budget')
    expect(options()).toHaveLength(1)
    key(input(), 'Enter')
    expect(location.hash).toBe('#/library?source=src')
    expect(useWorkspace.getState().selectedSourceId).toBe('src')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never searches body text, trash, excluded sources, or derived world reference nodes', () => {
    useKnowledge.setState({ sources: [source('blocked', 'Hiddenmatch excluded source', { nodeId: 'source-node', excluded: true }), source('deleted', 'Hiddenmatch deleted', { deleted: true })] })
    useWorld.getState().hydrate(null, [
      node('allowed', 'Public local record'), node('source-node', 'Hiddenmatch excluded projection'),
      node('trash', 'Hiddenmatch trash', { deletedAt: 4 }), node('excluded', 'Hiddenmatch excluded node', { corpusExcluded: true }),
      node('derived', 'Hiddenmatch generated page', { provenance: { source: 'file', ref: 'worldview:artifact:page', keptAt: 0 } }),
    ])
    act(() => openCommandMenu())
    type('hiddenmatch')
    expect(options()).toHaveLength(0)
    type('secret body-only')
    expect(options()).toHaveLength(0)
    type('public')
    expect(options()).toHaveLength(1)
    key(input(), 'Enter')
    expect(useWorkspace.getState().selectedRecordId).toBe('allowed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('removes newly excluded metadata while open', () => {
    useKnowledge.setState({ sources: [source('src', 'Aurora decision', { nodeId: 'projection' })] })
    useWorld.getState().hydrate(null, [node('projection', 'Aurora decision')])
    act(() => openCommandMenu())
    type('aurora')
    expect(options()).toHaveLength(1)
    act(() => useKnowledge.setState({ sources: [source('src', 'Aurora decision', { nodeId: 'projection', excluded: true })] }))
    expect(options()).toHaveLength(0)
    key(input(), 'Enter')
    expect(location.hash).toBe('#/today')
  })

  it('dispatches capture after the modal closes so destination focus is retained', () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const capture = vi.fn(() => {
      expect(menu()?.open ?? false).toBe(false)
      textarea.focus()
    })
    window.addEventListener('worldview:capture', capture)
    act(() => openCommandMenu())
    key(input(), 'Enter')
    expect(capture).toHaveBeenCalledOnce()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(textarea)
    act(() => openCommandMenu())
    key(input(), 'N', { ctrlKey: true, shiftKey: true })
    expect(capture).toHaveBeenCalledTimes(2)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(textarea)
    window.removeEventListener('worldview:capture', capture)
    textarea.remove()
  })

  it('leaves 3D shortcuts alone, ignores composition, and closes on account changes', async () => {
    location.hash = '#/explore'
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(key(window, 'k', { metaKey: true }).defaultPrevented).toBe(false)
    act(() => openCommandMenu())
    expect(menu()).toBeNull()
    location.hash = '#/today'
    expect(key(window, 'k', { metaKey: true, isComposing: true }).defaultPrevented).toBe(false)
    act(() => openCommandMenu())
    expect(menu()).not.toBeNull()
    act(() => useAuth.setState({ user: { id: 'other-account', email: 'local@example.invalid' } }))
    expect(menu()).toBeNull()
  })
})
