import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { radiusOf } from '../../domain/placement.ts'
import { yOf } from '../../domain/time.ts'
import { LAYER } from '../layers.ts'
import { playheadEpoch } from './clock.ts'
import { labelStride, ringYears } from './timeScale.ts'

// <YearRings/>: time made legible in the world. A faint horizontal ring around the node field
// on 1 January of every year the Timeline ticks (timeScale.ts, so the two always agree), with
// screen-space year labels at the ring's right-hand edge, thinned so they never crowd. The
// present plane is a faint disc at the playhead's height that moves as you scrub. A year
// hovered on the Timeline (useApp.timeFocusYear) lights its ring.

const SEGMENTS = 96
const MIN_RADIUS = 30
const RADIUS_MARGIN = 8
/** HUD bars to keep labels clear of (px from top and bottom). */
const TOP_CLEAR = 76
const BOTTOM_CLEAR = 100
/** Room kept at the right edge for a year label (px). */
const LABEL_ROOM = 56

const DIM = new Color('#d9d4c7').multiplyScalar(0.1)
const MARKED = new Color('#d9d4c7').multiplyScalar(0.22)
const FOCUS = new Color('#e8b04a').multiplyScalar(1.6)

function ringGeometry(ys: readonly number[], r: number): BufferGeometry {
  const pos = new Float32Array(ys.length * SEGMENTS * 6)
  const col = new Float32Array(ys.length * SEGMENTS * 6)
  let o = 0
  for (const y of ys) {
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2
      pos.set([Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r], o)
      o += 6
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('color', new BufferAttribute(col, 3))
  return g
}

const _p = new Vector3()
const _q = new Vector3()
const _right = new Vector3()

export function YearRings() {
  const settings = useWorld((s) => s.settings)
  const nodes = useWorld((s) => s.nodes)
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)

  const radius = useMemo(() => {
    let r = 0
    for (const n of nodes.values()) r = Math.max(r, radiusOf(n.anchorXZ))
    return Math.max(MIN_RADIUS, r + RADIUS_MARGIN)
  }, [nodes])

  // Years change at most at New Year; recomputing on settings is enough between reloads.
  const years = useMemo(() => (settings ? ringYears(settings, Date.now()) : []), [settings])
  const ys = useMemo(() => (settings ? years.map((y) => yOf(Date.UTC(y, 0, 1), settings.T0, settings.yPerYear)) : []), [years, settings])

  const lineMat = useMemo(() => new LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, depthWrite: false }), [])
  const rings = useMemo(() => {
    const l = new LineSegments(ringGeometry(ys, radius), lineMat)
    l.name = 'year-rings'
    l.layers.set(LAYER.SOLID)
    l.raycast = () => {}
    l.frustumCulled = false
    return l
  }, [ys, radius, lineMat])
  useEffect(() => () => rings.geometry.dispose(), [rings])

  const present = useMemo(() => {
    const disc = new Mesh(
      new CircleGeometry(radius, 96).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: '#e8b04a', transparent: true, opacity: 0.035, depthWrite: false, side: DoubleSide, toneMapped: false }),
    )
    const edgeGeo = new BufferGeometry().setFromPoints(
      Array.from({ length: 128 }, (_, i) => new Vector3(Math.cos((i / 128) * Math.PI * 2) * radius, 0, Math.sin((i / 128) * Math.PI * 2) * radius)),
    )
    const edge = new LineLoop(edgeGeo, new LineBasicMaterial({ color: new Color('#e8b04a').multiplyScalar(0.9), toneMapped: false }))
    disc.add(edge)
    disc.name = 'present-plane'
    disc.layers.set(LAYER.SOLID)
    edge.layers.set(LAYER.SOLID)
    disc.raycast = () => {}
    edge.raycast = () => {}
    disc.renderOrder = 1
    return disc
  }, [radius])
  useEffect(
    () => () => {
      present.geometry.dispose()
      ;(present.material as MeshBasicMaterial).dispose()
      const edge = present.children[0] as LineLoop
      edge.geometry.dispose()
      ;(edge.material as LineBasicMaterial).dispose()
    },
    [present],
  )
  useEffect(() => () => lineMat.dispose(), [lineMat])

  // Screen-space year labels: one pooled div per year, shown when its stride says so.
  const labelRoot = useRef<HTMLDivElement | null>(null)
  const labelEls = useRef(new Map<number, HTMLDivElement>())
  useEffect(() => {
    const parent = gl.domElement.parentElement
    if (!parent) return
    const root = document.createElement('div')
    root.className = 'wv-labels'
    root.setAttribute('aria-hidden', 'true')
    parent.append(root)
    labelRoot.current = root
    const els = labelEls.current
    return () => {
      root.remove()
      labelRoot.current = null
      els.clear()
    }
  }, [gl])

  const st = useRef({ stride: 0, focus: null as number | null, rings: null as LineSegments | null })

  useFrame((state) => {
    if (!settings) return
    const cam = state.camera as PerspectiveCamera
    const focus = useApp.getState().timeFocusYear

    // Present plane follows the playhead.
    present.position.y = yOf(playheadEpoch(settings), settings.T0, settings.yPerYear)

    // Stride from the on-screen spacing of one year at the ring nearest the camera's height.
    _right.setFromMatrixColumn(cam.matrixWorld, 0).setY(0)
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0)
    _right.normalize().multiplyScalar(radius)
    _p.set(_right.x, cam.position.y, _right.z).project(cam)
    _q.set(_right.x, cam.position.y + settings.yPerYear, _right.z).project(cam)
    const pxPerYear = Math.abs(_q.y - _p.y) * 0.5 * size.height
    const stride = labelStride(pxPerYear, 24)

    const s = st.current
    if (stride !== s.stride || focus !== s.focus || rings !== s.rings) {
      s.stride = stride
      s.focus = focus
      s.rings = rings
      const col = rings.geometry.getAttribute('color') as BufferAttribute
      const C = col.array as Float32Array
      years.forEach((y, i) => {
        const c = y === focus ? FOCUS : y % stride === 0 ? MARKED : DIM
        for (let k = 0; k < SEGMENTS * 2; k++) C.set([c.r, c.g, c.b], (i * SEGMENTS * 2 + k) * 3)
      })
      col.needsUpdate = true
    }

    const root = labelRoot.current
    if (!root) return
    years.forEach((year, i) => {
      let el = labelEls.current.get(year)
      const want = year % stride === 0 || year === focus
      if (want) {
        // On the ring's right-hand side; when that is off screen (close framing), slide inward
        // along the camera's right axis until the label fits.
        _p.set(_right.x, ys[i], _right.z).project(cam)
        if ((_p.x * 0.5 + 0.5) * size.width > size.width - LABEL_ROOM) {
          let lo = 0
          let hi = 1
          for (let it = 0; it < 10; it++) {
            const mid = (lo + hi) / 2
            _p.set(_right.x * mid, ys[i], _right.z * mid).project(cam)
            if ((_p.x * 0.5 + 0.5) * size.width > size.width - LABEL_ROOM) hi = mid
            else lo = mid
          }
          _p.set(_right.x * lo, ys[i], _right.z * lo).project(cam)
        }
        const x = (_p.x * 0.5 + 0.5) * size.width
        const y = (-_p.y * 0.5 + 0.5) * size.height
        const visible = _p.z < 1 && _p.z > -1 && x > 0 && x <= size.width - LABEL_ROOM + 1 && y > TOP_CLEAR && y < size.height - BOTTOM_CLEAR
        if (visible) {
          if (!el) {
            el = document.createElement('div')
            el.className = 'wv-year'
            el.textContent = String(year)
            root.append(el)
            labelEls.current.set(year, el)
          }
          el.classList.add('is-shown')
          el.classList.toggle('is-focus', year === focus)
          el.style.transform = `translate3d(${Math.round(x + 6)}px, ${Math.round(y - 8)}px, 0)`
          return
        }
      }
      el?.classList.remove('is-shown')
    })
  })

  if (!settings || years.length === 0) return null
  return (
    <group name="time-marks">
      <primitive object={rings} />
      <primitive object={present} />
    </group>
  )
}

