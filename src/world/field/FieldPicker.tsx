import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Plane, Raycaster, Vector2, Vector3 } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { updateNode } from '../../data/repo.ts'
import { getOrbitControls } from '../camera/flyTo.ts'
import { flyIn } from '../splats/index.tsx'
import { getFieldFrame, previewFieldAnchor } from './runtime.ts'

// Hover and click in the field: grains have no meshes to raycast, so picking is in screen
// space: the born note whose cloud centre is nearest the pointer, within its on-screen cloud
// (at least PICK_PX). A click is a press and release that barely moved, so orbit drags never
// select; a click on empty land clears the selection. A double-click on a note that holds a
// captured scene walks into it.

const PICK_PX = 26
const CLICK_SLOP = 5
const _v = new Vector3()

export function FieldPicker() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)

  useEffect(() => {
    const canvas = gl.domElement
    let down: { x: number; y: number } | null = null
    let hovered: string | null = null
    let drag: { id: string; plane: Plane; offset: Vector3; before?: [number, number]; xz: [number, number] } | null = null
    const ray = new Raycaster()
    const hit = new Vector3()
    const pointer = new Vector2()
    const pointOn = (e: PointerEvent, plane: Plane) => {
      const r = canvas.getBoundingClientRect()
      pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1)
      ray.setFromCamera(pointer, camera)
      return ray.ray.intersectPlane(plane, hit)
    }

    const pick = (clientX: number, clientY: number): string | null => {
      const r = canvas.getBoundingClientRect()
      const px = clientX - r.left
      const py = clientY - r.top
      const f = getFieldFrame()
      const fov = (camera as { fov?: number }).fov ?? 50
      const pxPerUnitAt1 = r.height / (2 * Math.tan((fov * Math.PI) / 360))
      let best: string | null = null
      let bestD = Infinity
      for (let i = 0; i < f.ids.length; i++) {
        if (!f.born[i]) continue
        _v.set(f.centers[i * 3], f.centers[i * 3 + 1], f.centers[i * 3 + 2])
        const dist = _v.distanceTo(camera.position)
        _v.project(camera)
        if (_v.z > 1 || _v.z < -1) continue
        const sx = (_v.x * 0.5 + 0.5) * r.width
        const sy = (-_v.y * 0.5 + 0.5) * r.height
        const d = Math.hypot(sx - px, sy - py)
        const reach = Math.max(PICK_PX, (f.sigma[i] * 1.2 * pxPerUnitAt1) / Math.max(dist, 1e-3))
        if (d < reach && d < bestD) {
          bestD = d
          best = f.ids[i]
        }
      }
      return best
    }

    const move = (e: PointerEvent) => {
      if (drag) {
        if (pointOn(e, drag.plane)) {
          hit.sub(drag.offset)
          const k = Math.min(1, 2800 / Math.max(1, Math.hypot(hit.x, hit.z)))
          drag.xz = [hit.x * k, hit.z * k]
          previewFieldAnchor(drag.id, drag.xz)
        }
        return
      }
      if (down) return
      const id = pick(e.clientX, e.clientY)
      if (id === hovered) return
      hovered = id
      useApp.getState().hover(id)
      canvas.style.cursor = id ? 'pointer' : ''
    }
    const press = (e: PointerEvent) => {
      if (e.button === 0 && e.shiftKey && useApp.getState().mode === 'orbit') {
        const id = pick(e.clientX, e.clientY)
        const f = getFieldFrame()
        const i = id ? f.index.get(id) : undefined
        if (id && i !== undefined) {
          const center = new Vector3().fromArray(f.centers, i * 3)
          const plane = new Plane(new Vector3(0, 1, 0), -center.y)
          if (pointOn(e, plane)) {
            drag = { id, plane, offset: hit.clone().sub(center), before: useWorld.getState().nodes.get(id)?.fieldAnchorXZ, xz: [center.x, center.z] }
            e.preventDefault()
            e.stopImmediatePropagation()
            const controls = getOrbitControls()
            if (controls) controls.enabled = false
            canvas.setPointerCapture(e.pointerId)
            canvas.style.cursor = 'grabbing'
            useApp.getState().select(id)
            return
          }
        }
      }
      if (e.button === 0) down = { x: e.clientX, y: e.clientY }
    }
    const release = (e: PointerEvent) => {
      if (drag) {
        const moved = drag
        drag = null
        down = null
        const controls = getOrbitControls()
        if (controls) controls.enabled = true
        canvas.style.cursor = ''
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
        void updateNode(moved.id, { fieldAnchorXZ: moved.xz }).then(() => {
          useApp.getState().pushToast({ message: 'Moved this landmark', undo: () => updateNode(moved.id, { fieldAnchorXZ: moved.before }).then(() => {}) })
        }).catch((error: unknown) => {
          useApp.getState().pushToast({ message: error instanceof Error ? error.message : 'Could not move this landmark', undo: () => {} })
        }).finally(() => previewFieldAnchor(moved.id, null))
        return
      }
      const d = down
      down = null
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return
      if (useApp.getState().mode !== 'orbit') return
      useApp.getState().select(pick(e.clientX, e.clientY))
    }
    // Double-click a note that holds a captured scene: walk into it.
    const enter = (e: MouseEvent) => {
      if (useApp.getState().mode !== 'orbit') return
      const id = pick(e.clientX, e.clientY)
      if (id && useWorld.getState().nodes.get(id)?.splat) void flyIn(id).catch(() => {})
    }
    const leave = () => {
      if (hovered) useApp.getState().hover(null)
      hovered = null
      canvas.style.cursor = ''
    }
    const cancel = () => {
      if (drag) previewFieldAnchor(drag.id, null)
      drag = null
      down = null
      const controls = getOrbitControls()
      if (controls) controls.enabled = true
      leave()
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerdown', press, true)
    canvas.addEventListener('pointerup', release)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointercancel', cancel)
    canvas.addEventListener('dblclick', enter)
    return () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerdown', press, true)
      canvas.removeEventListener('pointerup', release)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('dblclick', enter)
      canvas.style.cursor = ''
      if (drag) previewFieldAnchor(drag.id, null)
      const controls = getOrbitControls()
      if (controls) controls.enabled = true
    }
  }, [gl, camera])

  return null
}
