import { describe, expect, it } from 'vitest'
import { useApp } from '../../src/app/store.ts'
import { closePalette, openPalette, usePaletteIntent } from '../../src/hud/shortcuts.ts'

// Regression: the palette used to clear link mode in its mount-effect cleanup, which React
// StrictMode runs immediately after mount, so "Link to…" silently opened a plain palette.
// The intent must survive opening and be dropped only when the palette panel closes.
describe('palette link intent', () => {
  it('survives open and is cleared on any close path', () => {
    openPalette({ linkFrom: 'a' })
    expect(usePaletteIntent.getState().linkFrom).toBe('a')
    expect(useApp.getState().panels.palette).toBe(true)

    useApp.getState().escape() // Esc path closes panels without closePalette()
    expect(useApp.getState().panels.palette).toBe(false)
    expect(usePaletteIntent.getState().linkFrom).toBeNull()

    openPalette({ linkFrom: 'b' })
    closePalette()
    expect(usePaletteIntent.getState().linkFrom).toBeNull()

    openPalette()
    expect(usePaletteIntent.getState().linkFrom).toBeNull()
  })
})
