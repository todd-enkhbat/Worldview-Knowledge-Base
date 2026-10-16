import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, Matrix4, Quaternion, Vector3 } from 'three'
import fontUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url'
import { formatDotDate } from '../../domain/time.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import type { Landing, PathGraph } from '../paths.ts'
import { deckLabel, inwardLabel, outwardLabel, presentPlinth, type LabelPlacement } from './layout.ts'
import { PALETTE, hdr } from './materials.ts'

// In-world typography (troika SDF text, self-hosted JetBrains Mono): year numerals engraved into
// the landing parapets and decks, the Present marker, and the empty-world plinth. All on
// LAYER.LABELS so the reflector skips them. Numerals are pooled to the landings nearest the
// camera height, so the label count stays flat however many years the world spans.

export const LABEL_FONT = fontUrl

/** Landings that carry numerals at any time (2 Text meshes each). */
const NUMERAL_POOL = 12

const _m = new Matrix4()
const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()

export function placementQuaternion(l: LabelPlacement): Quaternion {
  _x.fromArray(l.x)
  _y.fromArray(l.y)
  _z.fromArray(l.z)
  return new Quaternion().setFromRotationMatrix(_m.makeBasis(_x, _y, _z))
}

interface EngravedProps {
  placement: LabelPlacement
  children: string
  size: number
  color?: string
  spacing?: number
  maxWidth?: number
  textAlign?: 'left' | 'right' | 'center' | 'justify'
  emissive?: string
  emissiveIntensity?: number
}

/** Text sunk into concrete: dark, matte, lit like the surface it is cut into. */
export function Engraved({
  placement,
  children,
  size,
  color = '#191816',
  spacing = 0.06,
  maxWidth,
  textAlign = 'center',
  emissive,
  emissiveIntensity = 0,
}: EngravedProps) {
  const quaternion = useMemo(() => placementQuaternion(placement), [placement])
  return (
    <Text
      font={LABEL_FONT}
      position={placement.position}
      quaternion={quaternion}
      fontSize={size}
      letterSpacing={spacing}
      anchorX="center"
      anchorY="middle"
      textAlign={textAlign}
      maxWidth={maxWidth}
      layers={LAYER.LABELS}
      renderOrder={RENDER_ORDER.LABELS}
    >
      {children}
      <meshStandardMaterial
        color={color}
        roughness={0.96}
        metalness={0}
        emissive={emissive ?? '#000000'}
        emissiveIntensity={emissiveIntensity}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </Text>
  )
}

function LandingNumerals({ landing, pitch }: { landing: Landing; pitch: number }) {
  const outer = useMemo(() => outwardLabel(landing.angle, landing.outerRadius + 0.012, landing.y - 0.35), [landing])
  // On the landing's widened deck, clear of the parapet; the helicoid is level along a radius.
  const floor = useMemo(() => deckLabel(landing.angle, landing.outerRadius - 1.45, landing.y, pitch), [landing, pitch])
  return (
    <>
      <Engraved placement={outer} size={1.15} spacing={0.12}>
        {String(landing.year)}
      </Engraved>
      <Engraved placement={floor} size={0.8} spacing={0.1} color="#1d1c1a">
        {String(landing.year)}
      </Engraved>
    </>
  )
}

/** Indices of the `k` landings nearest height y (landings are sorted by y). */
export function nearestLandings(landings: readonly Landing[], y: number, k: number): Landing[] {
  if (landings.length <= k) return [...landings]
  let lo = 0
  let hi = landings.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (landings[mid].y < y) lo = mid + 1
    else hi = mid
  }
  let a = lo - 1
  let b = lo
  const out: Landing[] = []
  while (out.length < k) {
    const da = a >= 0 ? y - landings[a].y : Infinity
    const db = b < landings.length ? landings[b].y - y : Infinity
    if (da <= db) out.push(landings[a--])
    else out.push(landings[b++])
  }
  return out.sort((p, q) => p.y - q.y)
}

export function YearNumerals({ graph }: { graph: PathGraph }) {
  const pitch = graph.helix.pitch
  const [bucket, setBucket] = useState(() => Math.round(graph.present.y / pitch))
  const last = useRef(bucket)
  useFrame(({ camera }) => {
    // Re-pool only when the camera crosses a turn: a state update at most once per year of height.
    const b = Math.round(camera.position.y / pitch)
    if (b !== last.current) {
      last.current = b
      setBucket(b)
    }
  })
  const visible = useMemo(() => nearestLandings(graph.landings, bucket * pitch, NUMERAL_POOL), [graph.landings, bucket, pitch])
  return (
    <group>
      {visible.map((l) => (
        <LandingNumerals key={l.year} landing={l} pitch={pitch} />
      ))}
    </group>
  )
}

export function PresentLabels({ graph }: { graph: PathGraph }) {
  const p = graph.present
  const pitch = graph.helix.pitch
  const outer = useMemo(() => outwardLabel(p.angle, p.outerRadius + 0.012, p.y - 0.55), [p])
  const floor = useMemo(() => deckLabel(p.angle, p.outerRadius - 2.2, p.y, pitch), [p, pitch])
  return (
    <>
      <Engraved placement={outer} size={1.0} spacing={0.32} color="#2a2118" emissive={PALETTE.ember} emissiveIntensity={0.9}>
        PRESENT
      </Engraved>
      <Engraved placement={floor} size={0.4} spacing={0.1} color="#1d1c1a">
        {`PRESENT\n${formatDotDate(graph.now)}`}
      </Engraved>
    </>
  )
}

// ─── empty-world plinth ─────────────────────────────────────────────────────────────────

/** Line drawing of the ⌘ glyph (not in the latin subset of the font, so drawn as geometry). */
export function createCommandGlyphGeometry(size = 1, segments = 20): BufferGeometry {
  const s = size * 0.22
  const r = size * 0.16
  const pts: number[] = []
  const seg = (ax: number, ay: number, bx: number, by: number) => pts.push(ax, ay, 0, bx, by, 0)
  // Central square.
  seg(-s, -s, s, -s)
  seg(s, -s, s, s)
  seg(s, s, -s, s)
  seg(-s, s, -s, -s)
  // Corner loops: 3/4 circles tangent to the square's extended sides.
  for (const [cx, cy] of [
    [-s - r, -s - r],
    [s + r, -s - r],
    [s + r, s + r],
    [-s - r, s + r],
  ]) {
    // Leave out the quarter facing the square's centre.
    const start = Math.atan2(-cy, -cx) + Math.PI / 4
    for (let i = 0; i < segments; i++) {
      const a0 = start + ((Math.PI * 1.5) * i) / segments
      const a1 = start + ((Math.PI * 1.5) * (i + 1)) / segments
      seg(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1))
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pts, 3))
  return g
}

function GlyphLines({ placement, size }: { placement: LabelPlacement; size: number }) {
  const geometry = useMemo(() => createCommandGlyphGeometry(size), [size])
  const material = useMemo(() => new LineBasicMaterial({ color: hdr(PALETTE.ember, 2.6), toneMapped: false }), [])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )
  const quaternion = useMemo(() => placementQuaternion(placement), [placement])
  return (
    <lineSegments
      geometry={geometry}
      material={material}
      position={placement.position}
      quaternion={quaternion}
      layers={LAYER.LABELS}
      renderOrder={RENDER_ORDER.LABELS}
    />
  )
}

export function EmptyWorldPlinth({ graph }: { graph: PathGraph }) {
  const pl = presentPlinth(graph)
  // The plinth's inner face (towards the core) at r − 0.5.
  const face = pl.r - 0.5 - 0.012
  const title = useMemo(() => inwardLabel(pl.angle, face, pl.top - 0.36), [pl.angle, face, pl.top])
  const key = useMemo(() => {
    const t = inwardLabel(pl.angle, face, pl.top - 0.82)
    return { glyph: shiftAlong(t, -0.18), letter: shiftAlong(t, 0.18) }
  }, [pl.angle, face, pl.top])
  return (
    <group>
      <Engraved placement={title} size={0.15} spacing={0.14} maxWidth={1.6} color={PALETTE.bone} emissive={PALETTE.bone} emissiveIntensity={0.25}>
        {'ADD YOUR FIRST\nMEMORY'}
      </Engraved>
      <GlyphLines placement={key.glyph} size={0.3} />
      <Engraved placement={key.letter} size={0.26} spacing={0} color={PALETTE.ember} emissive={PALETTE.ember} emissiveIntensity={1.4}>
        K
      </Engraved>
    </group>
  )
}

function shiftAlong(l: LabelPlacement, d: number): LabelPlacement {
  return {
    ...l,
    position: [l.position[0] + l.x[0] * d, l.position[1] + l.x[1] * d, l.position[2] + l.x[2] * d],
  }
}
