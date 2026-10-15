// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo, softDelete, useRepoStatus } from '../../src/data/repo.ts'
import { Banners } from '../../src/hud/Banners.tsx'
import { FirstRun } from '../../src/hud/FirstRun.tsx'
import { Settings } from '../../src/hud/Settings.tsx'
import { StorageBadge } from '../../src/hud/StorageBadge.tsx'
import { Trash } from '../../src/hud/Trash.tsx'
import { UndoToasts } from '../../src/hud/UndoToast.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)))

/** Flush until `cond` holds: fake-indexeddb needs a variable number of macrotasks under load. */
async function settle(cond: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && !cond(); i++) await flush()
}

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

function button(label: RegExp): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find((el) => label.test(el.textContent ?? ''))
  if (!b) throw new Error(`no button ${label}`)
  return b
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const text = () => document.body.textContent ?? ''

beforeEach(async () => {
  await initRepo({ store: createMemoryStore() })
  useApp.setState({ toasts: [], panels: { ...useApp.getState().panels, settings: false, trash: false } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await closeRepo()
  useWorld.getState().hydrate(null, [])
})

describe('FirstRun', () => {
  it('walks T0 → start → explainer → done and creates the world', async () => {
    render(<FirstRun />)
    expect(text()).toContain('When does your worldview begin?')

    const date = document.body.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    typeInto(date, '1700')
    act(() => button(/^Continue$/).click())
    expect(text()).toMatch(/at most 250 years/)

    typeInto(date, '1990-03-14')
    act(() => button(/^Continue$/).click())
    expect(text()).toContain('What should it start with?')

    act(() => document.body.querySelector<HTMLInputElement>('input[value="demo"]')!.click())
    act(() => button(/^Continue$/).click())
    expect(text()).toContain('Your world lives here')

    act(() => button(/^Understood$/).click())
    expect(text()).toContain('Ready.')
    expect(text()).toContain('1990-03-14')

    await act(async () => button(/Enter the world/).click())
    await flush()
    const s = useWorld.getState().settings
    expect(s?.T0).toBe(Date.UTC(1990, 2, 14))
    expect(useWorld.getState().nodes.size).toBeGreaterThan(10)
    expect(text()).not.toContain('Ready.')
  })

  it('Esc goes back a step', () => {
    render(<FirstRun />)
    const date = document.body.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    typeInto(date, '1990')
    act(() => button(/^Continue$/).click())
    expect(text()).toContain('What should it start with?')
    act(() => {
      document.body.querySelector('[role="dialog"] h1')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(text()).toContain('When does your worldview begin?')
  })
})

describe('with a world', () => {
  beforeEach(async () => {
    await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  })

  it('undo toast restores a soft delete', async () => {
    const n = await createNode({ archetype: 'idea', title: 'Entropy', temporalOrigin: Date.UTC(2010, 0, 1) })
    // createNode pushes its own "Created" undo toast; only the delete's matters here.
    useApp.setState({ toasts: [] })
    render(<UndoToasts />)
    await act(async () => {
      await softDelete(n.id)
    })
    expect(text()).toContain('Deleted Entropy')
    await act(async () => button(/^Undo$/).click())
    await flush()
    expect(useWorld.getState().nodes.has(n.id)).toBe(true)
    expect(useApp.getState().toasts).toHaveLength(0)
  })

  it('trash lists, restores and empties', async () => {
    const a = await createNode({ archetype: 'idea', title: 'Alpha', temporalOrigin: Date.UTC(2010, 0, 1) })
    const b = await createNode({ archetype: 'idea', title: 'Beta', temporalOrigin: Date.UTC(2012, 0, 1), anchorXZ: [40, 40] })
    await softDelete(a.id)
    await softDelete(b.id)
    act(() => useApp.getState().togglePanel('trash', true))
    render(<Trash />)
    await flush()
    expect(text()).toContain('Alpha')
    expect(text()).toContain('30 days left')

    await act(async () => button(/Restore Alpha|^Restore$/).click())
    await settle(() => useWorld.getState().nodes.has(a.id))
    expect(useWorld.getState().nodes.has(a.id)).toBe(true)

    act(() => button(/^Empty trash$/).click())
    expect(text()).toContain('cannot be undone')
    await act(async () => button(/Delete forever/).click())
    await settle(() => useWorld.getState().trash.size === 0 && text().includes('Trash is empty'))
    expect(useWorld.getState().trash.size).toBe(0)
    expect(text()).toContain('Trash is empty')
  })

  it('settings renders and the danger zone needs the typed phrase', async () => {
    act(() => useApp.getState().togglePanel('settings', true))
    render(<Settings />)
    await flush()
    for (const h of ['Storage', 'Backups', 'Import', 'Re-layout world', 'Quality', 'Credits', 'Danger zone']) expect(text()).toContain(h)
    expect(text()).toContain('lion.v3.spz')

    const wipe = button(/^Wipe world$/)
    expect(wipe.disabled).toBe(true)
    const inputs = [...document.body.querySelectorAll<HTMLInputElement>('input')]
    const confirm = inputs.find((i) => i.closest('form')?.textContent?.includes('to confirm'))!
    typeInto(confirm, 'wipe world')
    expect(wipe.disabled).toBe(false)
    await act(async () => wipe.click())
    await flush()
    expect(useWorld.getState().settings).toBeNull()
    expect(useApp.getState().panels.settings).toBe(false)
  })

  it('re-layout preview lists records outside the new range', async () => {
    await createNode({ archetype: 'idea', title: 'Early', temporalOrigin: Date.UTC(1995, 0, 1) })
    act(() => useApp.getState().togglePanel('settings', true))
    render(<Settings />)
    const t0 = [...document.body.querySelectorAll<HTMLInputElement>('input')].find((i) => i.placeholder === 'YYYY-MM-DD')!
    typeInto(t0, '2000')
    await act(async () => button(/^Preview$/).click())
    await flush()
    expect(text()).toContain('would fall outside')
    expect(text()).toContain('Early')

    typeInto(t0, '1992')
    await act(async () => button(/^Preview$/).click())
    await flush()
    await act(async () => button(/Apply re-layout/).click())
    await flush()
    expect(useWorld.getState().settings?.T0).toBe(Date.UTC(1992, 0, 1))
  })

  it('banners and badge reflect repo status', () => {
    render(
      <>
        <StorageBadge />
        <Banners />
      </>,
    )
    expect(text()).toContain('UNKNOWN')
    act(() => useRepoStatus.setState({ fallback: true }))
    expect(text()).toContain('MEMORY')
    expect(text()).toContain('Nothing will be saved')
    act(() => useRepoStatus.setState({ fallback: false, writer: false }))
    expect(text()).toContain('Read-only')
    act(() => useRepoStatus.setState({ writer: true, error: 'The app was updated in another tab. Reload this tab.' }))
    expect(button(/^Reload$/)).toBeTruthy()
  })
})
