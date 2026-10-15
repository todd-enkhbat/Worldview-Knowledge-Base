import { create } from 'zustand'
import type { Archetype, NodeRecord, QualityTier, WorldSettings } from '../domain/types.ts'

// ─── Camera-mode machine ────────────────────────────────────────────────────────────
// orbit         free CameraControls around the world (default)
// third_person  kinematic avatar on the catwalk path graph, damped follow cam
// first_person  generic 6-DOF flight (SparkControls)
// entering      fly-in tween into a memory diorama
// interior      inside a diorama: 6-DOF SparkControls with roll, world group hidden
// exiting       reverse of entering
// autonav       scripted ride along the worldline
// framing       splat framing modal (crop / up-fix / entry pose), in the main canvas
export type CameraMode =
  | 'orbit'
  | 'third_person'
  | 'first_person'
  | 'entering'
  | 'interior'
  | 'exiting'
  | 'autonav'
  | 'framing'

const TRANSITIONS: Record<CameraMode, readonly CameraMode[]> = {
  orbit: ['third_person', 'first_person', 'entering', 'autonav', 'framing'],
  third_person: ['orbit', 'first_person', 'entering', 'autonav', 'framing'],
  first_person: ['orbit', 'third_person', 'entering', 'framing'],
  entering: ['interior', 'exiting'],
  interior: ['exiting'],
  exiting: ['orbit', 'third_person', 'first_person'],
  autonav: ['orbit', 'third_person', 'first_person', 'entering'],
  framing: ['orbit', 'third_person', 'first_person'],
}

export function canTransition(from: CameraMode, to: CameraMode): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export const SPEEDS = [-10, -5, -2, -1, -0.5, -0.1, 0.1, 0.5, 1, 2, 5, 10] as const

export type PanelId = 'inspector' | 'library' | 'palette' | 'settings' | 'trash' | 'demons' | 'stats' | 'picker'

export interface EditorState {
  open: boolean
  /** null = creating a new node of `archetype`. */
  nodeId: string | null
  archetype: Archetype | null
}

export interface UndoToast {
  id: string
  message: string
  /** Called if the user presses Undo before the toast expires. */
  undo: () => void | Promise<void>
  expiresAt: number
}

export interface QualityState {
  tier: QualityTier
  dpr: number
  reflector: 'full' | '512' | 'off'
  /** Quality-ladder rung 3. True turns post DOF off everywhere (DOF is already off during the
   *  fly-in, so "DOF only during fly-in" collapses to none; see world/post/postMode.ts). */
  dofOnlyFlyIn: boolean
  lodSplatCount: number
}

export interface ClockState {
  /** Integer physics step at the playhead. */
  step: number
  speed: number
  playing: boolean
  /** Recompute in progress after an edit. */
  settling: boolean
}

interface AppState {
  mode: CameraMode
  prevMode: CameraMode
  selectedId: string | null
  hoveredId: string | null
  /** Memory whose diorama is focused / being entered. */
  focusedId: string | null
  clock: ClockState
  panels: Record<PanelId, boolean>
  editor: EditorState
  toasts: UndoToast[]
  quality: QualityState

  setMode: (to: CameraMode) => boolean
  select: (id: string | null) => void
  hover: (id: string | null) => void
  focus: (id: string | null) => void
  setClock: (patch: Partial<ClockState>) => void
  togglePanel: (id: PanelId, open?: boolean) => void
  openEditor: (e: Omit<EditorState, 'open'>) => void
  closeEditor: () => void
  pushToast: (t: Omit<UndoToast, 'id' | 'expiresAt'>, ttlMs?: number) => string
  dismissToast: (id: string) => void
  setQuality: (patch: Partial<QualityState>) => void
  /** Esc precedence: palette or modal, then first-person exit, then deselect. */
  escape: () => void
}

const closedPanels: Record<PanelId, boolean> = {
  inspector: false,
  library: false,
  palette: false,
  settings: false,
  trash: false,
  demons: false,
  stats: false,
  picker: false,
}

let toastSeq = 0

export const useApp = create<AppState>()((set, get) => ({
  mode: 'orbit',
  prevMode: 'orbit',
  selectedId: null,
  hoveredId: null,
  focusedId: null,
  clock: { step: 0, speed: 1, playing: false, settling: false },
  panels: { ...closedPanels },
  editor: { open: false, nodeId: null, archetype: null },
  toasts: [],
  quality: { tier: 'auto', dpr: 1.5, reflector: 'full', dofOnlyFlyIn: false, lodSplatCount: 1_500_000 },

  setMode: (to) => {
    const from = get().mode
    if (!canTransition(from, to)) return false
    if (from !== to) set({ mode: to, prevMode: from })
    return true
  },
  select: (id) => set((s) => ({ selectedId: id, panels: { ...s.panels, inspector: id !== null } })),
  hover: (id) => set({ hoveredId: id }),
  focus: (id) => set({ focusedId: id }),
  setClock: (patch) => set((s) => ({ clock: { ...s.clock, ...patch } })),
  togglePanel: (id, open) => set((s) => ({ panels: { ...s.panels, [id]: open ?? !s.panels[id] } })),
  openEditor: (e) => set({ editor: { ...e, open: true } }),
  closeEditor: () => set({ editor: { open: false, nodeId: null, archetype: null } }),
  pushToast: (t, ttlMs = 8000) => {
    const id = `toast-${++toastSeq}`
    set((s) => ({ toasts: [...s.toasts, { ...t, id, expiresAt: Date.now() + ttlMs }] }))
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setQuality: (patch) => set((s) => ({ quality: { ...s.quality, ...patch } })),
  escape: () => {
    const s = get()
    const modalOpen = s.panels.palette || s.panels.picker || s.panels.settings || s.panels.trash || s.editor.open
    if (modalOpen) {
      set({
        panels: { ...s.panels, palette: false, picker: false, settings: false, trash: false },
        editor: { open: false, nodeId: null, archetype: null },
      })
      return
    }
    if (s.mode === 'interior' || s.mode === 'entering') {
      s.setMode('exiting')
      return
    }
    if (s.mode === 'first_person' || s.mode === 'autonav' || s.mode === 'framing') {
      s.setMode(s.prevMode === s.mode ? 'orbit' : canTransition(s.mode, s.prevMode) ? s.prevMode : 'orbit')
      return
    }
    if (s.selectedId) s.select(null)
  },
}))

// ─── World data (mirror of the WorldStore, kept in sync by data/ + locks.ts) ─────────
interface WorldState {
  loaded: boolean
  settings: WorldSettings | null
  /** Live (non-deleted) records by id. */
  nodes: Map<string, NodeRecord>
  /** Soft-deleted records by id (trash). */
  trash: Map<string, NodeRecord>
  /** Bumped on every mutation; cheap dependency for memoised derived data. */
  revision: number
  storage: { persisted: boolean | null; origin: string; privateMode: boolean | null; usage: number | null; quota: number | null }

  hydrate: (settings: WorldSettings | null, records: NodeRecord[]) => void
  upsertLocal: (n: NodeRecord) => void
  removeLocal: (id: string) => void
  setSettingsLocal: (s: WorldSettings) => void
  setStorage: (patch: Partial<WorldState['storage']>) => void
}

export const useWorld = create<WorldState>()((set) => ({
  loaded: false,
  settings: null,
  nodes: new Map(),
  trash: new Map(),
  revision: 0,
  storage: {
    persisted: null,
    origin: typeof location === 'undefined' ? '' : location.origin,
    privateMode: null,
    usage: null,
    quota: null,
  },

  hydrate: (settings, records) => {
    const nodes = new Map<string, NodeRecord>()
    const trash = new Map<string, NodeRecord>()
    for (const r of records) (r.deletedAt === null ? nodes : trash).set(r.id, r)
    set((s) => ({ loaded: true, settings, nodes, trash, revision: s.revision + 1 }))
  },
  upsertLocal: (n) =>
    set((s) => {
      const nodes = new Map(s.nodes)
      const trash = new Map(s.trash)
      if (n.deletedAt === null) {
        nodes.set(n.id, n)
        trash.delete(n.id)
      } else {
        nodes.delete(n.id)
        trash.set(n.id, n)
      }
      return { nodes, trash, revision: s.revision + 1 }
    }),
  removeLocal: (id) =>
    set((s) => {
      const nodes = new Map(s.nodes)
      const trash = new Map(s.trash)
      nodes.delete(id)
      trash.delete(id)
      return { nodes, trash, revision: s.revision + 1 }
    }),
  setSettingsLocal: (settings) => set((s) => ({ settings, revision: s.revision + 1 })),
  setStorage: (patch) => set((s) => ({ storage: { ...s.storage, ...patch } })),
}))
