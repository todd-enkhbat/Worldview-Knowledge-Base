import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3, type PerspectiveCamera } from 'three'
import { useApp } from '../../app/store.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { formatByPrecision } from '../../domain/time.ts'
import { yearOf } from '../time/timeScale.ts'
import type { Archetype, NodeRecord } from '../../domain/types.ts'
import { getPoseTable } from '../poses.ts'
import { spatialWorldFor } from '../field/layout.ts'
import { useOrbitMotion } from '../camera/orbitMotion.ts'
import { clipTitle, countOverlaps, fieldLabelLevel, labelPriority, labelSize, pickLandmarks, placeLabels, sideBox, type LabelCandidate, type LabelLevel, type PlacedLabel } from './declutter.ts'
import { MIN_WORLD_TEXT_PX, worldTextPx } from './labels.tsx'
import { flyIn } from '../splats/index.tsx'
import { PEEK_H, PEEK_W, peekKey, peekLabelSize, peekOf, peekUrl, type Peek } from './peek.ts'

// <ScreenLabels/>: constant-size HTML labels for every born node whose in-world text would be
// too small to read. One absolutely positioned overlay over the canvas; one pooled div per
// shown id. Placement (declutter.ts) is resampled a few times a second; positions follow
// the pose table every frame. Close nodes hand over to the in-world plaques (labels.tsx).

const RESAMPLE_SECONDS = 0.2
const MAX_LABELS = 40
/** HUD bars to keep clear (px from the top and bottom). */
const TOP_CLEAR = 76
const BOTTOM_CLEAR = 100
/** Gap between a node and its label (px). */
const LIFT = 8
const OVERVIEW_DISTANCE = 220

export interface OverviewLabelCandidate {
  id: string
  clusterId: string
  distance: number
  priority: number
  /** Selection and hover remain readable regardless of overview budgets. */
  pinned: boolean
}

/** Distant views name neighborhoods first; ordinary record labels get a small diverse budget. */
export function overviewLabelIds(candidates: readonly OverviewLabelCandidate[], limit = 3, previous: ReadonlySet<string> = new Set(), orbiting = false): Set<string> {
  const allowed = new Set(candidates.filter((c) => c.pinned || (!orbiting && c.distance <= OVERVIEW_DISTANCE)).map((c) => c.id))
  if (orbiting) return allowed
  const clusters = new Set<string>()
  const far = candidates.filter((c) => !allowed.has(c.id)).sort((a, b) => Number(previous.has(b.id)) - Number(previous.has(a.id)) || b.priority - a.priority || a.id.localeCompare(b.id))
  for (const candidate of far) {
    if (clusters.size >= limit) break
    if (clusters.has(candidate.clusterId)) continue
    clusters.add(candidate.clusterId)
    allowed.add(candidate.id)
  }
  return allowed
}

const TAG: Record<Archetype, string> = {
  idea: 'IDEA',
  entity: 'ENTITY',
  lens: 'LENS',
  document: 'DOCUMENT',
  memory: 'MEMORY',
  demon: 'DEMON',
}

export interface ReadabilityReport {
  born: number
  inView: number
  /** In view and readable: an in-world plaque at ≥ MIN_WORLD_TEXT_PX or a placed screen label. */
  readable: number
  screenLabels: number
  worldText: number
  overlaps: number
  /** Smallest title size on screen (px). */
  minTitlePx: number
}

let lastReport: ReadabilityReport | null = null
registerDevApi('readability', () => lastReport)

interface Slot {
  el: HTMLDivElement
  title: HTMLDivElement
  tag: HTMLDivElement
  key: string
  shown: boolean
  hiddenAt: number
  /** The note's picture, video or scene (peek.ts), when it has one. */
  peek: { key: string; box: HTMLDivElement; media: HTMLImageElement | HTMLVideoElement; url: string | null } | null
}

function makeSlot(root: HTMLElement): Slot {
  const el = document.createElement('div')
  el.className = 'wv-label'
  el.addEventListener('click', (e) => {
    const id = el.dataset.nodeId
    if (id) { e.stopPropagation(); useApp.getState().select(id) }
  })
  const tag = document.createElement('div')
  tag.className = 'wv-label-tag'
  const title = document.createElement('div')
  title.className = 'wv-label-title'
  el.append(tag, title)
  root.append(el)
  return { el, title, tag, key: '', shown: false, hiddenAt: 0, peek: null }
}

function dropPeek(s: Slot): void {
  if (!s.peek) return
  if (s.peek.media instanceof HTMLVideoElement) {
    s.peek.media.pause()
    s.peek.media.removeAttribute('src')
    s.peek.media.load()
  }
  if (s.peek.url) URL.revokeObjectURL(s.peek.url)
  s.peek.box.remove()
  s.peek = null
}

/** Show `peek` in the slot (or none), loading its bytes once per key. */
function setPeek(s: Slot, id: string, peek: Peek | null): void {
  const key = peek ? peekKey(peek) : ''
  if ((s.peek?.key ?? '') === key) return
  dropPeek(s)
  if (!peek) return
  const box = document.createElement('div')
  box.className = 'wv-label-peek'
  box.style.width = `${PEEK_W}px`
  box.style.height = `${PEEK_H}px`
  box.title = peek.kind === 'scene' ? 'Open this scene (double-click to walk in)' : `Open this ${peek.kind === 'video' ? 'video' : 'picture'}`
  box.addEventListener('click', (e) => {
    e.stopPropagation()
    useApp.getState().select(id)
  })
  if (peek.kind === 'scene') box.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    void flyIn(id).catch(() => {})
  })
  let media: HTMLImageElement | HTMLVideoElement
  if (peek.kind === 'video') {
    const v = document.createElement('video')
    v.muted = true
    v.loop = true
    v.playsInline = true
    v.autoplay = true
    media = v
  } else {
    const img = document.createElement('img')
    img.alt = ''
    img.decoding = 'async'
    media = img
  }
  box.append(media)
  s.el.prepend(box)
  const slot = { key, box, media, url: null as string | null }
  s.peek = slot
  void peekUrl(peek).then((url) => {
    if (s.peek !== slot) {
      if (url) URL.revokeObjectURL(url)
      return
    }
    if (!url) return void box.classList.add('is-missing')
    slot.url = url
    media.src = url
    if (media instanceof HTMLVideoElement) void media.play().catch(() => {})
  })
}

interface Props {
  records: readonly NodeRecord[]
  byId: ReadonlyMap<string, NodeRecord>
  /** Label every node on screen (no in-world plaques to hand over to: the particle world). */
  always?: boolean
}

const _v = new Vector3()

/** HUD panels marked data-label-avoid (the link legend), as boxes in canvas px. */
function hudBoxes(canvas: HTMLCanvasElement): [number, number, number, number][] {
  const c = canvas.getBoundingClientRect()
  const out: [number, number, number, number][] = []
  // Topic labels are the primary reading layer at overview distance.
  for (const el of document.querySelectorAll('[data-label-avoid], .world-banners, .knowledge-district-label, .world-agent-label')) {
    const r = el.getBoundingClientRect()
    // An agent's caption sits below its body: reserve the actual avatar above it too.
    const above = el.classList.contains('world-agent-label') ? 90 : 6
    if (r.width > 0 && r.height > 0) out.push([r.left - c.left - 6, r.top - c.top - above, r.right - c.left + 6, r.bottom - c.top + 6])
  }
  return out
}

export function ScreenLabels({ records, byId, always = false }: Props) {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const slots = useRef(new Map<string, Slot>())
  const placed = useRef<PlacedLabel[]>([])
  const last = useRef(-Infinity)
  const lastOrbit = useRef(false)
  const spatial = useMemo(() => spatialWorldFor(byId), [byId])

  const graph = useMemo(() => {
    const nbrs = new Map<string, Set<string>>()
    const add = (a: string, b: string) => {
      let s = nbrs.get(a)
      if (!s) nbrs.set(a, (s = new Set()))
      s.add(b)
    }
    for (const n of byId.values()) {
      for (const l of n.links) {
        if (l.targetId === n.id || !byId.has(l.targetId)) continue
        add(n.id, l.targetId)
        add(l.targetId, n.id)
      }
    }
    return nbrs
  }, [byId])
  const landmarks = useMemo(() => pickLandmarks(new Map([...graph].map(([id, s]) => [id, s.size])), 12), [graph])
  /** Each shown label's level in the field (title only, or with its picture). */
  const levels = useRef(new Map<string, LabelLevel>())

  useEffect(() => {
    const parent = gl.domElement.parentElement
    if (!parent) return
    const root = document.createElement('div')
    root.className = `wv-labels${always ? ' is-molecular' : ''}`
    root.setAttribute('aria-hidden', 'true')
    parent.append(root)
    rootRef.current = root
    const map = slots.current
    return () => {
      for (const s of map.values()) dropPeek(s)
      root.remove()
      rootRef.current = null
      map.clear()
    }
  }, [gl, always])

  useFrame((state) => {
    const root = rootRef.current
    if (!root) return
    const cam = state.camera as PerspectiveCamera
    const table = getPoseTable()
    const W = size.width
    const H = size.height
    const t = state.clock.elapsedTime
    const orbiting = useOrbitMotion.getState().playing
    const project = (id: string): { x: number; y: number; d: number } | null => {
      const row = table.index.get(id)
      if (row === undefined || table.born[row] !== 1) return null
      const o = row * 3
      _v.set(table.pos[o], table.pos[o + 1], table.pos[o + 2])
      const d = _v.distanceTo(cam.position)
      _v.project(cam)
      if (_v.z > 1 || _v.z < -1) return null
      return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H, d }
    }

    if (orbiting !== lastOrbit.current || t - last.current >= RESAMPLE_SECONDS || t < last.current) {
      last.current = t
      lastOrbit.current = orbiting
      const { selectedId, hoveredId, timeFocusYear, mode } = useApp.getState()
      // Inside a memory's scene (and on the way in or out) the world's labels step aside.
      const inside = mode === 'entering' || mode === 'interior' || mode === 'exiting'
      const selNbrs = selectedId ? graph.get(selectedId) : undefined
      const cands: LabelCandidate[] = []
      const previous = new Map(placed.current.map((label) => [label.id, label]))
      const distances = new Map<string, number>()
      let born = 0
      let inView = 0
      let worldText = 0
      let minWorldPx = Infinity
      levels.current.clear()
      for (const rec of inside ? [] : records) {
        const row = table.index.get(rec.id)
        if (row === undefined || table.born[row] !== 1) continue
        born++
        const p = project(rec.id)
        if (!p || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue
        inView++
        const full = rec.id === hoveredId || rec.id === selectedId
        // The camera tour names regions; pointing or selecting still names an actual record.
        if (orbiting && !full) continue
        const px = always ? 0 : worldTextPx(rec, p.d, cam, H)
        if (px >= MIN_WORLD_TEXT_PX) {
          worldText++
          minWorldPx = Math.min(minWorldPx, px)
          continue
        }
        const inFocusYear = timeFocusYear !== null && yearOf(rec.temporalOrigin) === timeFocusYear
        // The field names things as you come near, not all at once (classic hands over to plaques).
        const overview = !full && p.d > OVERVIEW_DISTANCE
        const level: LabelLevel = overview ? 'title' : always
          ? fieldLabelLevel({ distance: p.d, degree: graph.get(rec.id)?.size ?? 0, pinned: full || !!selNbrs?.has(rec.id) || inFocusYear || (records.length <= 64 && !rec.splat), landmark: landmarks.has(rec.id) || records.length <= 64, scene: !!rec.splat?.proxyAssetId })
          : 'peek'
        if (level === 'none') continue
        levels.current.set(rec.id, level)
        const title = full ? rec.title : clipTitle(rec.title)
        const tag = `${TAG[rec.archetype]} · ${formatByPrecision(rec.temporalOrigin, rec.temporalPrecision)}`
        const peek = level === 'peek' ? peekOf(rec) : null
        const measured = labelSize(title, tag)
        const plain = !full && (always || overview) ? { w: measured.w, h: 25 } : measured
        const sz = peek ? peekLabelSize(plain) : plain
        const sides = peek ? ['below', 'right', 'left', 'above'] as const : ['above', 'right', 'left', 'below'] as const
        const priorSide = previous.get(rec.id)?.side
        distances.set(rec.id, p.d)
        cands.push({
          id: rec.id,
          x: p.x,
          y: p.y,
          w: Math.min(sz.w, full ? 420 : sz.w),
          h: sz.h,
          // A note with a picture, video or scene is labelled underneath, clear of its cloud,
          // and a little ahead of plain notes: it is the one you cannot read from grains alone.
          sides: priorSide ? [priorSide, ...sides.filter((side) => side !== priorSide)] : sides,
          ...(peek ? { compact: { w: Math.min(plain.w, full ? 420 : plain.w), h: plain.h } } : {}),
          priority: (peek ? 3000 : 0) + (timeFocusYear !== null && yearOf(rec.temporalOrigin) === timeFocusYear ? 2e5 : 0) + labelPriority({
            selected: rec.id === selectedId,
            hovered: rec.id === hoveredId,
            linkedToSelection: !!selNbrs?.has(rec.id),
            degree: graph.get(rec.id)?.size ?? 0,
            distance: p.d,
          }),
        })
      }
      const allowed = overviewLabelIds(cands.map((candidate) => ({
        id: candidate.id,
        clusterId: spatial.clusterOf.get(candidate.id) ?? candidate.id,
        distance: distances.get(candidate.id) ?? Infinity,
        priority: candidate.priority,
        pinned: candidate.id === selectedId || candidate.id === hoveredId,
      })), 3, new Set(previous.keys()), orbiting)
      placed.current = placeLabels(cands.filter((candidate) => allowed.has(candidate.id)), {
        width: W,
        height: H,
        max: Math.min(MAX_LABELS, Math.max(3, Math.min(10, Math.floor(W / 140)))),
        lift: LIFT,
        avoid: [[0, 0, W, TOP_CLEAR], [0, H - BOTTOM_CLEAR, W, H], ...hudBoxes(gl.domElement)],
      })

      const want = new Set(placed.current.map((p) => p.id))
      for (const p of placed.current) {
        const rec = byId.get(p.id)
        if (!rec) continue
        let s = slots.current.get(p.id)
        if (!s) slots.current.set(p.id, (s = makeSlot(root)))
        const full = rec.id === hoveredId || rec.id === selectedId
        const overview = !full && (project(rec.id)?.d ?? 0) > OVERVIEW_DISTANCE
        const title = full ? rec.title : clipTitle(rec.title)
        const tag = `${TAG[rec.archetype]} · ${formatByPrecision(rec.temporalOrigin, rec.temporalPrecision)}`
        const inYear = timeFocusYear !== null && yearOf(rec.temporalOrigin) === timeFocusYear
        const key = `${title}\u0000${tag}\u0000${rec.id === selectedId ? 's' : ''}${inYear ? 'y' : ''}${overview ? 'o' : ''}`
        s.el.dataset.nodeId = rec.id
        if (s.key !== key) {
          s.key = key
          s.title.textContent = title
          s.tag.textContent = tag
          s.el.classList.toggle('is-selected', rec.id === selectedId)
          s.el.classList.toggle('is-year', inYear)
          s.el.classList.toggle('is-overview', overview)
          s.el.style.width = `${p.w}px`
        }
        // Where there is no room for the picture, the title alone.
        setPeek(s, rec.id, p.compact || levels.current.get(rec.id) !== 'peek' ? null : peekOf(rec))
        if (!s.shown) {
          s.shown = true
          s.el.classList.add('is-shown')
        }
      }
      for (const [id, s] of slots.current) {
        if (want.has(id)) continue
        if (s.shown) {
          s.shown = false
          s.hiddenAt = t
          s.el.classList.remove('is-shown')
        } else if (t - s.hiddenAt > 1) {
          dropPeek(s)
          s.el.remove()
          slots.current.delete(id)
        }
      }

      lastReport = {
        born,
        inView,
        readable: worldText + placed.current.length,
        screenLabels: placed.current.length,
        worldText,
        overlaps: countOverlaps(placed.current),
        minTitlePx: Math.min(placed.current.length ? 12 : Infinity, minWorldPx),
      }
    }

    // Follow the poses every frame; the placement (and its declutter) is the resampled one.
    for (const p of placed.current) {
      const s = slots.current.get(p.id)
      const q = project(p.id)
      if (!s) continue
      if (!q) {
        s.el.style.visibility = 'hidden'
        continue
      }
      s.el.style.visibility = ''
      const b = sideBox(q.x, q.y, p.w, p.h, p.side, LIFT)
      s.el.style.transform = `translate3d(${Math.round(b.left)}px, ${Math.round(b.top)}px, 0)`
    }
  })

  return null
}
