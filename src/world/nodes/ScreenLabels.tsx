import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3, type PerspectiveCamera } from 'three'
import { useApp } from '../../app/store.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { formatByPrecision } from '../../domain/time.ts'
import { yearOf } from '../time/timeScale.ts'
import type { Archetype, NodeRecord } from '../../domain/types.ts'
import { getPoseTable } from '../poses.ts'
import { clipTitle, countOverlaps, labelPriority, labelSize, placeLabels, sideBox, type LabelCandidate, type PlacedLabel } from './declutter.ts'
import { MIN_WORLD_TEXT_PX, worldTextPx } from './labels.tsx'

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
}

function makeSlot(root: HTMLElement): Slot {
  const el = document.createElement('div')
  el.className = 'wv-label'
  const tag = document.createElement('div')
  tag.className = 'wv-label-tag'
  const title = document.createElement('div')
  title.className = 'wv-label-title'
  el.append(tag, title)
  root.append(el)
  return { el, title, tag, key: '', shown: false, hiddenAt: 0 }
}

interface Props {
  records: readonly NodeRecord[]
  byId: ReadonlyMap<string, NodeRecord>
}

const _v = new Vector3()

/** HUD panels marked data-label-avoid (the link legend), as boxes in canvas px. */
function hudBoxes(canvas: HTMLCanvasElement): [number, number, number, number][] {
  const c = canvas.getBoundingClientRect()
  const out: [number, number, number, number][] = []
  for (const el of document.querySelectorAll('[data-label-avoid]')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0) out.push([r.left - c.left - 6, r.top - c.top - 6, r.right - c.left + 6, r.bottom - c.top + 6])
  }
  return out
}

export function ScreenLabels({ records, byId }: Props) {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const slots = useRef(new Map<string, Slot>())
  const placed = useRef<PlacedLabel[]>([])
  const last = useRef(-Infinity)

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

  useEffect(() => {
    const parent = gl.domElement.parentElement
    if (!parent) return
    const root = document.createElement('div')
    root.className = 'wv-labels'
    root.setAttribute('aria-hidden', 'true')
    parent.append(root)
    rootRef.current = root
    const map = slots.current
    return () => {
      root.remove()
      rootRef.current = null
      map.clear()
    }
  }, [gl])

  useFrame((state) => {
    const root = rootRef.current
    if (!root) return
    const cam = state.camera as PerspectiveCamera
    const table = getPoseTable()
    const W = size.width
    const H = size.height
    const t = state.clock.elapsedTime
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

    if (t - last.current >= RESAMPLE_SECONDS || t < last.current) {
      last.current = t
      const { selectedId, hoveredId, timeFocusYear } = useApp.getState()
      const selNbrs = selectedId ? graph.get(selectedId) : undefined
      const cands: LabelCandidate[] = []
      let born = 0
      let inView = 0
      let worldText = 0
      let minWorldPx = Infinity
      for (const rec of records) {
        const row = table.index.get(rec.id)
        if (row === undefined || table.born[row] !== 1) continue
        born++
        const p = project(rec.id)
        if (!p || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue
        inView++
        const px = worldTextPx(rec, p.d, cam, H)
        if (px >= MIN_WORLD_TEXT_PX) {
          worldText++
          minWorldPx = Math.min(minWorldPx, px)
          continue
        }
        const full = rec.id === hoveredId || rec.id === selectedId
        const title = full ? rec.title : clipTitle(rec.title)
        const tag = `${TAG[rec.archetype]} · ${formatByPrecision(rec.temporalOrigin, rec.temporalPrecision)}`
        const sz = labelSize(title, tag)
        cands.push({
          id: rec.id,
          x: p.x,
          y: p.y,
          w: Math.min(sz.w, full ? 420 : sz.w),
          h: sz.h,
          priority: (timeFocusYear !== null && yearOf(rec.temporalOrigin) === timeFocusYear ? 2e5 : 0) + labelPriority({
            selected: rec.id === selectedId,
            hovered: rec.id === hoveredId,
            linkedToSelection: !!selNbrs?.has(rec.id),
            degree: graph.get(rec.id)?.size ?? 0,
            distance: p.d,
          }),
        })
      }
      placed.current = placeLabels(cands, {
        width: W,
        height: H,
        max: MAX_LABELS,
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
        const title = full ? rec.title : clipTitle(rec.title)
        const tag = `${TAG[rec.archetype]} · ${formatByPrecision(rec.temporalOrigin, rec.temporalPrecision)}`
        const inYear = timeFocusYear !== null && yearOf(rec.temporalOrigin) === timeFocusYear
        const key = `${title}\u0000${tag}\u0000${rec.id === selectedId ? 's' : ''}${inYear ? 'y' : ''}`
        if (s.key !== key) {
          s.key = key
          s.title.textContent = title
          s.tag.textContent = tag
          s.el.classList.toggle('is-selected', rec.id === selectedId)
          s.el.classList.toggle('is-year', inYear)
          s.el.style.width = `${p.w}px`
        }
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
