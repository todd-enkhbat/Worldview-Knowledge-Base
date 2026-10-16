import { create } from 'zustand'
import type { SparkRenderer } from '@sparkjsdev/spark'
import type { Camera, Scene, WebGLRenderer } from 'three'
import { EventTimes, FrameRing } from './metrics.ts'
import type { SparkProbe } from './sparkProbe.ts'

// Toggles are React state (they mount/unmount features); everything measured per frame
// lives in the mutable `rt` singleton so the hot path never touches React.

export type DioramaMode = 'lod' | 'proxy' | 'both'
export type ProxyMethod = 'cut' | 'level' | 'subsample'
export type CameraPath = 'orbit' | 'static' | 'manual'

export interface Toggles {
  reflector: boolean
  /** EffectComposer (multisampling 0, HalfFloat) + threshold Bloom + AgX. Off = direct render. */
  post: boolean
  /** Replace bloom with a depth view (checks the depth-proxy band). */
  depthView: boolean
  points: boolean
  movingLod: boolean
  tween: boolean
  forceSinglePass: boolean
  /** Negative control: put Spark + splats on layer 0 so the reflector sees them. */
  leakSplats: boolean
  depthProxy: boolean
  /** Negative control: draw depth proxies at renderOrder −3 (before splats) instead of 100. */
  depthProxyEarly: boolean
  dioramaMode: DioramaMode
  proxyMethod: ProxyMethod
  path: CameraPath
}

export const DEFAULT_TOGGLES: Toggles = {
  reflector: true,
  post: true,
  depthView: false,
  points: true,
  movingLod: true,
  tween: true,
  forceSinglePass: true,
  leakSplats: false,
  depthProxy: true,
  depthProxyEarly: false,
  dioramaMode: 'lod',
  proxyMethod: 'cut',
  path: 'manual',
}

export interface ProxyInfo {
  method: ProxyMethod
  /** getLodTreeLevel depth, when method = level. */
  level?: number
  splats: number
  /** Selection (traversal / level / sampling) + extract, ms. */
  selectMs: number
  /** writeSpz v3 + re-parse into a SplatMesh, ms. */
  writeMs: number
  bytes: number
  /** Occupancy of a 48³ grid relative to the full set (centres; opacity-weighted). */
  coverage?: { cells: number; mass: number }
}

export interface DioramaInfo {
  name: string
  status: string
  splats?: number
  lodSplats?: number
  loadMs?: number
  convertMs?: number
  lodReadyMs?: number
  proxies: Partial<Record<ProxyMethod, ProxyInfo>>
  levels?: { level: number; n: number }[]
  error?: string
}

interface S1State {
  toggles: Toggles
  dioramas: DioramaInfo[]
  benchRunning: string | null
  /** Panels visible (H toggles; hide them for screenshots and clean measurements). */
  hud: boolean
  setHud: (hud: boolean) => void
  set: (patch: Partial<Toggles>) => void
  setDiorama: (i: number, patch: Partial<DioramaInfo>) => void
  setBench: (label: string | null) => void
}

export const useS1 = create<S1State>((set) => ({
  toggles: DEFAULT_TOGGLES,
  dioramas: [],
  benchRunning: null,
  hud: true,
  setHud: (hud) => set({ hud }),
  set: (patch) => set((s) => ({ toggles: { ...s.toggles, ...patch } })),
  setDiorama: (i, patch) =>
    set((s) => {
      const next = s.dioramas.slice()
      next[i] = { ...(next[i] ?? { name: '?', status: '', proxies: {} }), ...patch }
      return { dioramas: next }
    }),
  setBench: (label) => set({ benchRunning: label }),
}))

/** Mutable runtime handles shared by the scene, the panel and window.__s1. */
export const rt = {
  ring: new FrameRing(),
  spark: null as SparkRenderer | null,
  probe: null as SparkProbe | null,
  gl: null as WebGLRenderer | null,
  scene: null as Scene | null,
  camera: null as Camera | null,
  /** OrbitControls target (set by the rig), so window.__s1.view can aim the camera. */
  controls: null as { target: { set(x: number, y: number, z: number): void }; update(): void } | null,
  /** performance.now() when the scripted camera path started, or −1. */
  pathStart: -1,
  tweenActive: false,
  frameFlags: 0,
  /** Per-frame renderer.info, summed since the last reset. */
  info: { frames: 0, calls: 0, triangles: 0, points: 0, lines: 0 },
  splatSamples: { frames: 0, active: 0, generated: 0 },
  displaySwaps: 0,
  /** Spark draws (onBeforeRender calls) summed since reset: main camera vs any other. */
  draws: { main: 0, other: 0 },
  lastInfo: { calls: 0, triangles: 0, points: 0 },
  longTasks: { count: 0, totalMs: 0 },
  /** GPU time per frame (EXT_disjoint_timer_query_webgl2), from first to last callback. */
  gpu: new EventTimes(),
  gpuDisjoint: 0,
}

export function resetCounters(): void {
  rt.ring.reset()
  rt.probe?.reset()
  rt.info = { frames: 0, calls: 0, triangles: 0, points: 0, lines: 0 }
  rt.splatSamples = { frames: 0, active: 0, generated: 0 }
  rt.displaySwaps = 0
  rt.draws = { main: 0, other: 0 }
  rt.longTasks = { count: 0, totalMs: 0 }
  rt.gpu.reset()
  rt.gpuDisjoint = 0
}
