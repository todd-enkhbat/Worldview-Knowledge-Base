// @vitest-environment jsdom
import { act, createElement } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { MS_PER_YEAR, STEPS_PER_YEAR, Y_PER_YEAR } from '../../src/domain/constants.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { birthStep, epochAtStep } from '../../src/domain/time.ts'
import { Timeline } from '../../src/hud/Timeline.tsx'
import { getPlayhead, seekPlayhead, stepOfEpoch } from '../../src/world/time/clock.ts'
import { useSimStats } from '../../src/world/time/physicsClient.ts'

// The product timeline: dated births, reversible transport, and accessible seeking.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()
const T0 = NOW - 20 * MS_PER_YEAR
const settings: WorldSettings = {
  T0,
  yPerYear: Y_PER_YEAR,
  stepsPerYear: STEPS_PER_YEAR,
  physicsSeed: 1,
  qualityTier: 'auto',
  firstRunComplete: true,
  lastBackupAt: null,
  autoBackupEnabled: false,
  createdAt: T0,
  schemaVersion: 1,
}

let host: HTMLDivElement
let root: Root

function button(label: RegExp): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((el) => label.test(el.getAttribute('aria-label') ?? el.textContent ?? ''))
  if (!b) throw new Error(`no button ${label}`)
  return b
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
  useWorld.getState().hydrate(settings, [
    makeNodeDraft('memory', { id: 'm1', temporalOrigin: T0 + 2 * MS_PER_YEAR }),
    makeNodeDraft('idea', { id: 'i1', temporalOrigin: T0 + 9 * MS_PER_YEAR }),
  ])
  useApp.getState().setClock({ step: 0, speed: 1, playing: false, settling: false })
  seekPlayhead(0)
  useSimStats.setState({ mode: 'starting', stats: null, error: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Timeline)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useWorld.getState().hydrate(null, [])
  vi.restoreAllMocks()
})

describe('Timeline', () => {
  it('renders the axis, one birth tick per node and the playhead slider', () => {
    const slider = host.querySelector('[role="slider"]')!
    expect(slider.getAttribute('aria-valuemax')).toBe(String(25 * STEPS_PER_YEAR))
    expect(host.querySelectorAll('.timeline-birth')).toHaveLength(2)
    expect(host.querySelector('.timeline-now')).not.toBeNull()
    // 25 years of axis: a label every 5 years.
    const firstLabel = Math.ceil((new Date(T0).getUTCFullYear() + 1) / 5) * 5
    expect(host.textContent).toContain(`${firstLabel}${firstLabel + 5}`)
  })

  it('play/pause by button and Space; Space on a button is left to the button', () => {
    act(() => button(/^Play$/).click())
    expect(useApp.getState().clock.playing).toBe(true)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))
    })
    expect(useApp.getState().clock.playing).toBe(false)
    const b = button(/^Play$/)
    act(() => {
      b.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))
    })
    expect(useApp.getState().clock.playing).toBe(false)
  })

  it('speeds keep their direction; reverse flips it', () => {
    const speed = host.querySelector<HTMLSelectElement>('[aria-label="Playback speed"]')!
    act(() => { speed.value = '5'; speed.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(useApp.getState().clock.speed).toBe(5)
    act(() => button(/^Reverse playback$/).click())
    expect(useApp.getState().clock.speed).toBe(-5)
    act(() => { speed.value = '0.1'; speed.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(useApp.getState().clock.speed).toBe(-0.1)
    expect(button(/^Reverse playback$/).getAttribute('aria-pressed')).toBe('true')
  })

  it('Present and the keyboard move the playhead', () => {
    seekPlayhead(10)
    act(() => button(/^Back to today$/).click())
    const present = stepOfEpoch(settings, Date.now())
    expect(Math.abs(getPlayhead().step - present)).toBeLessThanOrEqual(1)
    expect(useApp.getState().clock.step).toBe(getPlayhead().step)
    const slider = host.querySelector<HTMLElement>('[role="slider"]')!
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(getPlayhead().step).toBe(0)
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    })
    expect(getPlayhead().step).toBe(STEPS_PER_YEAR)
  })

  it('reports edits settling without crowding the timeline with engine diagnostics', () => {
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
    act(() => useApp.getState().setClock({ settling: true }))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Updating…')
    act(() => useApp.getState().setClock({ settling: false }))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
  })

  it('keyboard seeking clamps to the complete history and future horizon', () => {
    const slider = host.querySelector<HTMLElement>('[role="slider"]')!
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(getPlayhead().step).toBe(0)
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    const end = getPlayhead().step
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(getPlayhead().step).toBe(end)
    expect(end).toBe(Number(slider.getAttribute('aria-valuemax')))
  })

  it('explains a date before any thought exists and jumps to the first birth', () => {
    expect(host.querySelector('.timeline-context')?.textContent).toContain('0 thoughts at this date')
    act(() => button(/^Jump to first thought$/).click())
    expect(getPlayhead().step).toBe(2 * STEPS_PER_YEAR)
    expect(host.querySelector('.timeline-context')?.textContent).toContain('1 thought at this date')
    expect(host.querySelector('.timeline-context button')).toBeNull()

    act(() => seekPlayhead(9 * STEPS_PER_YEAR))
    expect(host.querySelector('.timeline-context')?.textContent).toContain('2 thoughts at this date')
    act(() => seekPlayhead(0))
    expect(button(/^Jump to first thought$/)).toBeTruthy()
  })

  it('counts and jumps to the same quantized births as the shared pose writer', () => {
    const birth = epochAtStep(1200.2, settings.T0, settings.stepsPerYear)
    const futureBirth = epochAtStep(1200.75, settings.T0, settings.stepsPerYear)
    act(() => {
      useWorld.getState().hydrate(settings, [makeNodeDraft('memory', { id: 'fractional', temporalOrigin: birth }), makeNodeDraft('idea', { id: 'later', temporalOrigin: futureBirth })])
      seekPlayhead(1199)
    })
    expect(host.querySelector('.timeline-context')?.textContent).toContain('0 thoughts at this date')
    act(() => button(/^Jump to first thought$/).click())
    const firstVisibleStep = birthStep(birth, settings.T0, settings.stepsPerYear)
    expect(getPlayhead().step).toBe(firstVisibleStep)
    expect(getPlayhead().step).toBe(1200)
    expect(birthStep(futureBirth, settings.T0, settings.stepsPerYear)).toBeGreaterThan(getPlayhead().step)
    expect(host.querySelector('.timeline-context')?.textContent).toContain('1 thought at this date')
  })

  it('reduces year labels when the track has less space', () => {
    const track = host.querySelector<HTMLDivElement>('.timeline-track')!
    const originalCount = host.querySelectorAll('.timeline-year').length
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ width: 180 } as DOMRect)
    act(() => window.dispatchEvent(new Event('resize')))
    expect(host.querySelectorAll('.timeline-year').length).toBeLessThan(originalCount)
    expect(host.querySelectorAll('.timeline-birth')).toHaveLength(2)
  })
})
