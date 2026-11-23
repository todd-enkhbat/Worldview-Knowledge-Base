// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo } from '../../src/data/repo.ts'
import { Agents } from '../../src/hud/Agents.tsx'
import { getPoseTable, setPoseTable } from '../../src/world/poses.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const T0 = Date.UTC(2000, 0, 1)
function button(text: string) {
  const result = [...document.body.querySelectorAll('button')].find((el) => el.textContent?.trim() === text)
  if (!result) throw new Error(`Missing button: ${text}`)
  return result
}
function type(placeholder: string, value: string) {
  const field = document.body.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(async () => {
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0, start: 'empty' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await closeRepo()
  useWorld.getState().hydrate(null, [])
  setPoseTable({ index: new Map(), pos: new Float32Array(), born: new Uint8Array() })
})

describe('Agents panel', () => {
  it('reviews real local matches and persists a paused query', async () => {
    await createNode({ archetype: 'idea', title: 'Ocean currents', temporalOrigin: T0 })
    const scout = await createNode({ archetype: 'demon', title: 'Ocean scout', temporalOrigin: T0, demon: { query: 'ocean', active: true, radius: 3000 } })
    act(() => root.render(<Agents onClose={() => {}} />))
    expect(document.body.textContent).toContain('1 match from 1 nearby saved note')
    act(() => button('View notes').click())
    expect(document.body.querySelector('.agents-matches')?.textContent).toContain('Ocean currents')
    const toggle = document.body.querySelector<HTMLInputElement>('[aria-label="Activate Ocean scout agent"]')!
    await act(async () => toggle.click())
    expect(useWorld.getState().nodes.get(scout.id)?.demon?.active).toBe(false)
    expect(document.body.textContent).toContain('Paused')
    act(() => button('Check matches').click())
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('1 match checked locally just now')
  })

  it('creates a real standing query from the user’s topic without an AI call', async () => {
    act(() => root.render(<Agents onClose={() => {}} />))
    expect(document.body.textContent).toContain('No query agents yet')
    act(() => button('New agent').click())
    type('e.g. Research scout', 'My design scout')
    type('Topics, names, or ideas…', 'design')
    await act(async () => button('Create local agent').click())
    const [created] = [...useWorld.getState().nodes.values()]
    expect(created.title).toBe('My design scout')
    expect(created.archetype).toBe('demon')
    expect(created.demon).toEqual({ query: 'design', active: true, radius: 500 })
    expect(document.body.textContent).toContain('Idle · no matches yet')
  })

  it('refreshes match eligibility when history reveals a real record without editing it', async () => {
    const note = await createNode({ archetype: 'idea', title: 'Ocean currents', temporalOrigin: T0 })
    const scout = await createNode({ archetype: 'demon', title: 'Ocean scout', temporalOrigin: T0, demon: { query: 'ocean', active: true, radius: 30 } })
    setPoseTable({ index: new Map([[note.id, 0], [scout.id, 1]]), pos: new Float32Array([10, 75, 0, 0, 75, 0]), born: new Uint8Array([0, 1]) })
    act(() => root.render(<Agents onClose={() => {}} />))
    expect(document.body.textContent).toContain('0 matches from 0 nearby saved notes')
    act(() => {
      getPoseTable().born[0] = 1
      useApp.getState().setClock({ step: useApp.getState().clock.step + 1 })
    })
    expect(document.body.textContent).toContain('1 match from 1 nearby saved note')
    expect(useWorld.getState().nodes.get(note.id)?.updatedAt).toBe(note.updatedAt)
  })
})
