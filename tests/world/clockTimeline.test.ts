// @vitest-environment jsdom
import { act, createElement } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { MS_PER_YEAR, STEPS_PER_YEAR, Y_PER_YEAR } from '../../src/domain/constants.ts'
import type { WorldSettings } from '../../src/domain/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { Timeline } from '../../src/hud/Timeline.tsx'
import { getPlayhead, seekPlayhead, stepOfEpoch } from '../../src/world/time/clock.ts'
import { useSimStats } from '../../src/world/time/physicsClient.ts'

// The Timeline HUD in jsdom: transport, speeds, Present, Space, readouts, collapse.

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
})

describe('Timeline', () => {
  it('renders the axis, one birth tick per node and the playhead slider', () => {
    const slider = host.querySelector('[role="slider"]')!
    expect(slider.getAttribute('aria-valuemax')).toBe(String(25 * STEPS_PER_YEAR))
    expect(host.querySelectorAll('svg line')).toHaveLength(2)
    expect(host.textContent).toContain('NOW')
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
    act(() => button(/^5×$/).click())
    expect(useApp.getState().clock.speed).toBe(5)
    act(() => button(/^Reverse$/).click())
    expect(useApp.getState().clock.speed).toBe(-5)
    act(() => button(/^0\.1×$/).click())
    expect(useApp.getState().clock.speed).toBe(-0.1)
    expect(button(/^0\.1×$/).getAttribute('aria-pressed')).toBe('true')
  })

  it('Present and the keyboard move the playhead', () => {
    seekPlayhead(10)
    act(() => button(/^Present$/).click())
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

  it('readouts: — before stats; values, settling and static once they arrive', () => {
    expect(host.textContent).toMatch(/S—/)
    act(() => {
      useSimStats.setState({
        mode: 'physics',
        stats: {
          activeCount: 12,
          S: -3.456,
          energy: { origin: 100, e0: 5, raw: 0.5, births: 0.49, rampWork: 0.0099, ledger: 0.0001 },
          checkpoints: 7,
          settling: false,
          overflowSentinel: 0,
        },
      })
    })
    expect(host.textContent).toContain('-3.46')
    expect(host.textContent).toContain('+1.0e-4')
    expect(host.textContent).toMatch(/ckpt7/)
    expect(host.textContent).not.toContain('settling')
    act(() => useApp.getState().setClock({ settling: true }))
    expect(host.textContent).toContain('settling')
    act(() => useSimStats.setState({ mode: 'static', error: 'no worker' }))
    expect(host.textContent).toContain('static')
  })

  it('collapses to a thin bar and back (remembered)', () => {
    act(() => button(/Collapse the timeline/).click())
    expect(host.querySelector('svg')).toBeNull()
    expect(host.querySelector('[role="slider"]')).not.toBeNull()
    expect(localStorage.getItem('hud.timeline.collapsed')).toBe('1')
    act(() => button(/Expand the timeline/).click())
    expect(host.querySelectorAll('svg line')).toHaveLength(2)
  })
})
