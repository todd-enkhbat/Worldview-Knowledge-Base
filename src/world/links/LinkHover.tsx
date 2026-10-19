import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { getPoseTable } from '../poses.ts'
import { LINK_STYLE, buildTypedLinks, distToSegment2, linkSentence } from './style.ts'

// <LinkHover/>: names the link under the pointer ("A — supports → B") in a small tooltip.
// Picking is in screen space against the projected segments, so it costs nothing until the
// pointer moves, and a hovered node always wins over a link.

const PICK_PX = 6
const _a = new Vector3()
const _b = new Vector3()

export function LinkHover() {
  const nodes = useWorld((s) => s.nodes)
  const links = useMemo(() => buildTypedLinks(nodes), [nodes])
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const tip = useRef<HTMLDivElement | null>(null)
  const pointer = useRef({ x: 0, y: 0, inside: false, dirty: false })

  useEffect(() => {
    const canvas = gl.domElement
    const parent = canvas.parentElement
    if (!parent) return
    const el = document.createElement('div')
    el.className = 'wv-link-tip'
    el.setAttribute('role', 'tooltip')
    parent.append(el)
    tip.current = el
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true, dirty: true }
    }
    const leave = () => {
      pointer.current = { ...pointer.current, inside: false, dirty: true }
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerleave', leave)
    return () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerleave', leave)
      el.remove()
      tip.current = null
    }
  }, [gl])

  useFrame((state) => {
    const p = pointer.current
    const el = tip.current
    if (!el || !p.dirty) return
    p.dirty = false
    if (!p.inside || useApp.getState().hoveredId || links.length === 0) {
      el.classList.remove('is-shown')
      return
    }
    const table = getPoseTable()
    const cam = state.camera
    let best = -1
    let bestD = PICK_PX * PICK_PX
    for (let i = 0; i < links.length; i++) {
      const ra = table.index.get(links[i].from)
      const rb = table.index.get(links[i].to)
      if (ra === undefined || rb === undefined || table.born[ra] !== 1 || table.born[rb] !== 1) continue
      _a.set(table.pos[ra * 3], table.pos[ra * 3 + 1], table.pos[ra * 3 + 2]).project(cam)
      _b.set(table.pos[rb * 3], table.pos[rb * 3 + 1], table.pos[rb * 3 + 2]).project(cam)
      if (Math.abs(_a.z) > 1 || Math.abs(_b.z) > 1) continue
      const d = distToSegment2(
        p.x,
        p.y,
        (_a.x * 0.5 + 0.5) * size.width,
        (-_a.y * 0.5 + 0.5) * size.height,
        (_b.x * 0.5 + 0.5) * size.width,
        (-_b.y * 0.5 + 0.5) * size.height,
      )
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) {
      el.classList.remove('is-shown')
      return
    }
    const l = links[best]
    el.textContent = linkSentence(l, (id) => nodes.get(id)?.title ?? id)
    el.style.borderLeftColor = LINK_STYLE[l.kind].color
    // Flip to the pointer's other side when the tip would run off the stage.
    const w = el.offsetWidth
    const h = el.offsetHeight
    const x = p.x + 14 + w > size.width ? p.x - 14 - w : p.x + 14
    const y = p.y + 14 + h > size.height ? p.y - 14 - h : p.y + 14
    el.style.transform = `translate3d(${Math.round(Math.max(0, x))}px, ${Math.round(Math.max(0, y))}px, 0)`
    el.classList.add('is-shown')
  })

  return null
}
