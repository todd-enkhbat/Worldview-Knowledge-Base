import { useEffect } from 'react'
import { create } from 'zustand'
import { useApp, useWorld } from '../app/store.ts'
import type { CameraMode } from '../app/store.ts'
import { softDelete } from '../data/repo.ts'
import { stepAtEpoch, yOf } from '../domain/time.ts'
import type { Archetype } from '../domain/types.ts'
import { flyTo } from '../world/camera/flyTo.ts'
import { isEditableTarget } from '../world/camera/keyboard.ts'
import { saveWorldArchive } from './DurabilityKit.tsx'

// HUD commands and global keys. Keyboard shortcuts, TopBar buttons, the Inspector and the
// Cmd+K palette all dispatch through these functions so every entry point behaves the same.
// Esc is not handled here: the camera rig owns it (useApp.escape), and modals handle their
// own Esc because the rig ignores keys typed into inputs.

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
/** Prefix for the palette hint: "⌘K" on Apple platforms, "Ctrl+K" elsewhere. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+'

// ─── palette intent ──────────────────────────────────────────────────────────────────
// PanelId 'palette' is a boolean, so link mode ("link the selected node to …") rides along
// here. Always open the palette through openPalette so a stale link mode never leaks.

export interface PaletteIntent {
  /** When set, choosing a node links linkFrom → that node instead of flying to it. */
  linkFrom: string | null
}

export const usePaletteIntent = create<PaletteIntent>()(() => ({ linkFrom: null }))

// However the palette closes (Esc via useApp.escape, an action, a toggle), drop link mode so a
// stale intent never leaks into the next open.
useApp.subscribe((s, prev) => {
  if (prev.panels.palette && !s.panels.palette && usePaletteIntent.getState().linkFrom !== null) {
    usePaletteIntent.setState({ linkFrom: null })
  }
})

export function openPalette(opts: { linkFrom?: string | null } = {}): void {
  usePaletteIntent.setState({ linkFrom: opts.linkFrom ?? null })
  useApp.getState().togglePanel('palette', true)
}

export function closePalette(): void {
  useApp.getState().togglePanel('palette', false)
  usePaletteIntent.setState({ linkFrom: null })
}

// ─── commands ────────────────────────────────────────────────────────────────────────

/** Any modal that owns the keyboard (palette, picker, editor, settings, trash). */
export function isModalOpen(s = useApp.getState()): boolean {
  const p = s.panels
  return p.palette || p.picker || p.settings || p.trash || s.editor.open
}

export function selectAndFly(id: string): boolean {
  useApp.getState().select(id)
  return flyTo(id)
}

export function openPicker(): void {
  useApp.getState().togglePanel('picker', true)
}

export function newNode(archetype: Archetype): void {
  useApp.getState().openEditor({ nodeId: null, archetype })
}

export function editNode(id: string): boolean {
  const node = useWorld.getState().nodes.get(id)
  if (!node) return false
  useApp.getState().openEditor({ nodeId: id, archetype: node.archetype })
  return true
}

/** Soft delete; the repo pushes the Undo toast and clears the selection. */
export async function deleteNode(id: string): Promise<void> {
  try {
    // Inside the try: repo actions throw synchronously when the repo is not ready.
    await softDelete(id)
  } catch (e) {
    console.warn('[hud] delete failed', e)
  }
}

/** Move the playhead to now and fly to the present on the worldline. */
export function goToPresent(now = Date.now()): boolean {
  const settings = useWorld.getState().settings
  if (!settings) return false
  useApp.getState().setClock({ step: Math.max(0, Math.round(stepAtEpoch(now, settings.T0, settings.stepsPerYear))) })
  return flyTo([0, yOf(now, settings.T0, settings.yPerYear), 0], { distance: 40 })
}

/**
 * User-initiated export. Delegates to the durability kit's saveWorldArchive (native save
 * dialog or download, through exportWorld so it stamps lastBackupAt). Call it straight from
 * the user gesture: the save picker opens before anything is awaited.
 */
export async function exportBackup(): Promise<'saved' | 'cancelled'> {
  const r = await saveWorldArchive()
  return r.method === 'cancelled' ? 'cancelled' : 'saved'
}

// ─── global keys ─────────────────────────────────────────────────────────────────────

export type ShortcutId = 'palette' | 'new' | 'library' | 'settings' | 'stats' | 'delete' | 'edit'

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

export interface ShortcutContext {
  /** Focus is in an input, textarea, select or contenteditable. */
  typing: boolean
  /** A modal owns the keyboard. */
  modal: boolean
  /** First run is complete and the world is loaded. */
  ready: boolean
  mode: CameraMode
  selectedId: string | null
}

// First-person flight and the diorama interior bind letter keys (Spark's 6-DOF controls
// roll on Q/E), so E and Delete only act where the camera does not want them.
const EDIT_MODES: readonly CameraMode[] = ['orbit', 'third_person', 'autonav']
const DELETE_MODES: readonly CameraMode[] = ['orbit', 'third_person', 'first_person', 'autonav']

/** Mnemonic letter from e.key, falling back to the physical key on non-Latin layouts. */
function letterOf(e: KeyLike): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : ''
}

/** Which HUD shortcut a key press means in this context, or null. Pure, for tests. */
export function resolveShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutId | null {
  if (!ctx.ready || ctx.typing || e.repeat) return null
  const letter = letterOf(e)
  // Allowed with a modal open so ⌘K can close the palette; runShortcut will not stack it on another modal.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && letter === 'k') return 'palette'
  if (e.metaKey || e.ctrlKey || e.altKey || ctx.modal) return null
  if (e.key === ',') return 'settings'
  if (e.key === '`' || (e.code === 'Backquote' && !e.shiftKey)) return 'stats'
  if (e.shiftKey) return null
  if (e.key === 'Delete' || e.key === 'Backspace') {
    return ctx.selectedId && DELETE_MODES.includes(ctx.mode) ? 'delete' : null
  }
  switch (letter) {
    case 'n':
      return 'new'
    case 'l':
      return 'library'
    case 'e':
      return ctx.selectedId && EDIT_MODES.includes(ctx.mode) ? 'edit' : null
    default:
      return null
  }
}

export function runShortcut(id: ShortcutId): void {
  const app = useApp.getState()
  switch (id) {
    case 'palette':
      if (app.panels.palette) closePalette()
      else if (!isModalOpen(app)) openPalette()
      break
    case 'new':
      openPicker()
      break
    case 'library':
      app.togglePanel('library')
      break
    case 'settings':
      app.togglePanel('settings', true)
      break
    case 'stats':
      app.togglePanel('stats')
      break
    case 'delete':
      if (app.selectedId) void deleteNode(app.selectedId)
      break
    case 'edit':
      if (app.selectedId) editNode(app.selectedId)
      break
  }
}

/** Installs the global HUD keys on window (bubble phase, like the camera rig). Mount once. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const app = useApp.getState()
      const world = useWorld.getState()
      const id = resolveShortcut(e, {
        typing: isEditableTarget(e.target),
        modal: isModalOpen(app),
        ready: world.loaded && world.settings?.firstRunComplete === true,
        mode: app.mode,
        selectedId: app.selectedId,
      })
      if (!id) return
      e.preventDefault()
      runShortcut(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
