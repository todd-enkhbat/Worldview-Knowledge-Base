import { memo, useCallback, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { Vector3, type Camera, type Group } from 'three'
import monoBold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url'
import monoRegular from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?url'
import { useApp } from '../../app/store.ts'
import { memoryLabel } from '../../domain/memoryIndex.ts'
import { formatByPrecision, formatDotDate } from '../../domain/time.ts'
import type { Archetype, NodeRecord } from '../../domain/types.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { getPoseTable, type PoseTable } from '../poses.ts'
import { SLAB, TESSERACT } from './geometry.ts'
import { nodeScale, nodeYaw, recordFarScale } from './instancing.ts'
import { COLORS } from './materials.ts'

// Pooled troika labels: only the K nearest born nodes to the camera (plus the selection)
// carry text. The set is recomputed a few times per second; React re-renders only when the
// set changes. Placement runs every frame from the pose table. Memories carry their plaque
// typography and documents their engraved title; every other archetype gets a billboard.

export const LABEL_POOL_SIZE = 40
const RESAMPLE_SECONDS = 0.25

/** Billboard height above the pose, in node-scale units. */
const BILLBOARD_LIFT: Record<Archetype, number> = {
  idea: 0.85,
  entity: 1.75,
  lens: 1.05,
  document: 0,
  memory: 0,
  demon: 1.0,
}

const ARCHETYPE_NAME: Record<Archetype, string> = {
  idea: 'IDEA',
  entity: 'ENTITY',
  lens: 'LENS',
  document: 'DOCUMENT',
  memory: 'MEMORY',
  demon: 'DEMON',
}

const EMBER_TEXT = COLORS.ember.clone().multiplyScalar(2.4)
// Lime-filled engraving: a pale inlay reads on the slab in any light; dark-on-dark
// engraving vanished on the shadowed side of the slab.
const ENGRAVED = '#aaa397'

/** Plaques and slab faces have fixed room; long titles end in an ellipsis. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** "MEMORY 001: Title [MM.DD.YYYY]"; the number comes from domain/memoryIndex.ts, as in the Inspector. */
export function memoryPlaqueText(rec: NodeRecord, rank: number): string {
  return `${memoryLabel(rank)}: ${clip(rec.title, 48)} [${formatDotDate(rec.temporalOrigin)}]`
}

interface PoolProps {
  records: readonly NodeRecord[]
  byId: ReadonlyMap<string, NodeRecord>
  memoryRank: ReadonlyMap<string, number>
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function LabelPool({ records, byId, memoryRank }: PoolProps) {
  const [ids, setIds] = useState<readonly string[]>([])
  const groups = useRef(new Map<string, Group>())
  const st = useRef({
    last: -Infinity,
    records: null as readonly NodeRecord[] | null,
    bestD: new Float64Array(LABEL_POOL_SIZE),
    bestI: new Int32Array(LABEL_POOL_SIZE),
  })

  const register = useCallback((id: string, g: Group | null) => {
    if (g) groups.current.set(id, g)
    else groups.current.delete(id)
  }, [])

  useFrame((state) => {
    const s = st.current
    const t = state.clock.elapsedTime
    const table = getPoseTable()
    if (t - s.last >= RESAMPLE_SECONDS || t < s.last || s.records !== records) {
      s.last = t
      s.records = records
      const next = nearestIds(records, table, state.camera, s.bestD, s.bestI, useApp.getState().selectedId)
      if (!sameIds(next, ids)) setIds(next)
    }
    for (let i = 0; i < ids.length; i++) {
      const g = groups.current.get(ids[i])
      const rec = byId.get(ids[i])
      if (g && rec) place(g, rec, table, state.camera)
    }
  }, -1)

  return (
    <group name="node-labels">
      {ids.map((id) => {
        const rec = byId.get(id)
        return rec ? <NodeLabel key={id} rec={rec} rank={memoryRank.get(id) ?? 0} register={register} /> : null
      })}
    </group>
  )
}

/** K nearest born nodes to the camera, in record order, plus the selection. */
function nearestIds(
  records: readonly NodeRecord[],
  table: PoseTable,
  camera: Camera,
  bestD: Float64Array,
  bestI: Int32Array,
  selectedId: string | null,
): string[] {
  const K = bestD.length
  const cx = camera.position.x
  const cy = camera.position.y
  const cz = camera.position.z
  let count = 0
  for (let i = 0; i < records.length; i++) {
    const row = table.index.get(records[i].id)
    if (row === undefined || table.born[row] !== 1) continue
    const o = row * 3
    const dx = table.pos[o] - cx
    const dy = table.pos[o + 1] - cy
    const dz = table.pos[o + 2] - cz
    const d2 = dx * dx + dy * dy + dz * dz
    if (count === K && d2 >= bestD[K - 1]) continue
    let j = count < K ? count++ : K - 1
    while (j > 0 && bestD[j - 1] > d2) {
      bestD[j] = bestD[j - 1]
      bestI[j] = bestI[j - 1]
      j--
    }
    bestD[j] = d2
    bestI[j] = i
  }
  const order = Array.from(bestI.subarray(0, count)).sort((a, b) => a - b)
  const out = order.map((i) => records[i].id)
  if (selectedId && !out.includes(selectedId) && table.index.has(selectedId)) out.push(selectedId)
  return out
}

const _cam = new Vector3()

function place(g: Group, rec: NodeRecord, table: PoseTable, camera: Camera): void {
  const row = table.index.get(rec.id)
  if (row === undefined || table.born[row] !== 1) {
    g.visible = false
    return
  }
  g.visible = true
  const o = row * 3
  // Plaques and engravings ride on the mesh, so they take its distance boost too.
  camera.getWorldPosition(_cam)
  const s = nodeScale(rec) * recordFarScale(rec, Math.hypot(table.pos[o] - _cam.x, table.pos[o + 1] - _cam.y, table.pos[o + 2] - _cam.z))
  const lift = BILLBOARD_LIFT[rec.archetype]
  if (rec.archetype === 'memory' || rec.archetype === 'document') {
    g.position.set(table.pos[o], table.pos[o + 1], table.pos[o + 2])
    g.rotation.set(0, nodeYaw(rec), 0)
    g.scale.setScalar(s)
  } else {
    g.position.set(table.pos[o], table.pos[o + 1] + lift * s, table.pos[o + 2])
    g.quaternion.copy(camera.quaternion)
    g.scale.setScalar(1)
  }
}

interface LabelProps {
  rec: NodeRecord
  rank: number
  register: (id: string, g: Group | null) => void
}

const textCommon = { layers: LAYER.LABELS, renderOrder: RENDER_ORDER.LABELS } as const

const NodeLabel = memo(function NodeLabel({ rec, rank, register }: LabelProps) {
  const id = rec.id
  const ref = useCallback((g: Group | null) => register(id, g), [id, register])

  if (rec.archetype === 'memory') {
    const p = TESSERACT.plaque
    return (
      <group ref={ref} visible={false}>
        <Text
          {...textCommon}
          font={monoBold}
          fontSize={0.1}
          maxWidth={p.w - 0.24}
          lineHeight={1.25}
          letterSpacing={0.04}
          textAlign="center"
          anchorX="center"
          anchorY="middle"
          position={[0, p.y, p.z + p.d / 2 + 0.004]}
          color={EMBER_TEXT}
        >
          {memoryPlaqueText(rec, rank)}
        </Text>
      </group>
    )
  }

  if (rec.archetype === 'document') {
    const z = SLAB.d / 2 + 0.003
    return (
      <group ref={ref} visible={false}>
        <Text
          {...textCommon}
          font={monoBold}
          fontSize={0.12}
          maxWidth={SLAB.w - 0.3}
          lineHeight={1.15}
          letterSpacing={0.03}
          textAlign="left"
          anchorX="center"
          anchorY="bottom"
          position={[0, SLAB.h * 0.17 + 0.06, z]}
          color={ENGRAVED}
        >
          {clip(rec.title, 64).toUpperCase()}
        </Text>
        <Text
          {...textCommon}
          font={monoRegular}
          fontSize={0.065}
          letterSpacing={0.2}
          anchorX="center"
          anchorY="bottom"
          position={[0, -SLAB.h / 2 + 0.16, z]}
          color={ENGRAVED}
        >
          {`DOCUMENT · ${formatByPrecision(rec.temporalOrigin, rec.temporalPrecision)}`}
        </Text>
      </group>
    )
  }

  return (
    <group ref={ref} visible={false}>
      <Text
        {...textCommon}
        font={monoRegular}
        fontSize={0.075}
        letterSpacing={0.22}
        anchorX="center"
        anchorY="bottom"
        position={[0, 0, 0]}
        color={COLORS.concrete.getStyle()}
      >
        {`${ARCHETYPE_NAME[rec.archetype]} · ${formatByPrecision(rec.temporalOrigin, rec.temporalPrecision)}`}
      </Text>
      <Text
        {...textCommon}
        font={monoBold}
        fontSize={0.19}
        maxWidth={3.2}
        lineHeight={1.1}
        textAlign="center"
        anchorX="center"
        anchorY="bottom"
        position={[0, 0.12, 0]}
        color={COLORS.bone.getStyle()}
      >
        {clip(rec.title, 90)}
      </Text>
    </group>
  )
})
