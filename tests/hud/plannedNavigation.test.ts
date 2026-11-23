import { afterEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { canNavigateTo, goToPresent, navigateTo, setWorldView } from '../../src/hud/shortcuts.ts'

const original = useApp.getState()
const originalWorld = useWorld.getState()
afterEach(() => { useApp.setState(original, true); useWorld.setState(originalWorld, true) })

describe('planned world navigation', () => {
  it('permits world walking and memory rides in both render treatments', () => {
    for (const world of ['field', 'classic'] as const) {
      useApp.setState({ mode: 'orbit', view: { ...original.view, world } })
      expect(useApp.getState().setMode('third_person')).toBe(true)
      expect(useApp.getState().mode).toBe('third_person')
      expect(useApp.getState().setMode('autonav')).toBe(true)
      expect(useApp.getState().mode).toBe('autonav')
    }
  })

  it('keeps a walk or ride active when changing the render treatment', () => {
    for (const mode of ['third_person', 'autonav'] as const) {
      useApp.setState({ mode, view: { ...original.view, world: 'classic' } })
      setWorldView('field')
      expect(useApp.getState().mode).toBe(mode)
      expect(useApp.getState().view.world).toBe('field')
      setWorldView('classic')
      expect(useApp.getState().mode).toBe(mode)
    }
  })

  it('lets a flyer start a ride through the permitted orbit handoff', () => {
    useApp.setState({ mode: 'first_person', view: { ...original.view, world: 'field' } })
    // The underlying state machine retains its direct-transition rule.
    expect(useApp.getState().setMode('autonav')).toBe(false)
    expect(canNavigateTo('autonav')).toBe(true)
    expect(navigateTo('autonav')).toBe(true)
    expect(useApp.getState().mode).toBe('autonav')
  })

  it('leaves protected memory transitions and interiors undisturbed', () => {
    for (const mode of ['entering', 'interior'] as const) {
      useApp.setState({ mode })
      expect(canNavigateTo('third_person')).toBe(false)
      expect(navigateTo('third_person')).toBe(false)
      expect(navigateTo('autonav')).toBe(false)
      expect(useApp.getState().mode).toBe(mode)
    }
  })

  it('returns history to today without leaving spatial navigation or moving selection', () => {
    const T0 = Date.UTC(2000, 0, 1)
    useWorld.setState({ settings: { T0, stepsPerYear: 600 } as WorldSettings })
    useApp.setState({ mode: 'first_person', selectedId: 'a' })
    expect(goToPresent(T0 + 2 * MS_PER_YEAR)).toBe(true)
    expect(useApp.getState().clock.step).toBe(1200)
    expect(useApp.getState().mode).toBe('first_person')
    expect(useApp.getState().selectedId).toBe('a')
  })
})
