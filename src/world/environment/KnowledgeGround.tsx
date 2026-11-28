import { sceneMotionEnabled } from '../camera/cameraFlight.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineBasicMaterial, LineLoop, LineSegments, MeshStandardMaterial, Object3D, PlaneGeometry, Vector3, type InstancedMesh } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { getPoseTable } from '../poses.ts'
import { playheadEpoch } from '../time/clock.ts'
import { LAYER } from '../layers.ts'
import { groundBirthPhase, groundYAt, spatialGroundFor, type GroundDistrict, type SpatialGroundPlan } from './knowledgeGround.ts'
import { exploreDistrict } from './exploreDistrict.ts'
import { chooseDistrictLabels, type DistrictLabelCandidate } from './districtLabels.ts'
import './KnowledgeGround.css'

const COLORS = ['#80a9c5', '#c2a677', '#8aafaa', '#ada4c0', '#b7b5a2', '#8fa4bd']
const MAX_WAVE_DOTS = 1536

function createSurface(plan: SpatialGroundPlan): PlaneGeometry {
  const { minX, maxX, minZ, maxZ } = plan.bounds
  const width = maxX - minX, depth = maxZ - minZ
  // A static, bounded mesh follows broad shoulders closely enough for walk/ride closeups.
  const geometry = new PlaneGeometry(width, depth, Math.max(32, Math.min(384, Math.ceil(width / 3))), Math.max(32, Math.min(384, Math.ceil(depth / 3))))
  geometry.rotateX(-Math.PI / 2)
  geometry.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
  const position = geometry.getAttribute('position') as BufferAttribute
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i)
    const height = groundYAt(plan, x, z)
    position.setY(i, height + .018)
  }
  geometry.computeVertexNormals(); geometry.computeBoundingSphere()
  return geometry
}

function createGroundMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: '#07131f', roughness: .98, metalness: 0, envMapIntensity: .015, emissive: '#020912', emissiveIntensity: .08, transparent: true, depthWrite: false })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vDistrictPosition;\nvarying float vDatumDistance;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvDistrictPosition = position;\nvDatumDistance = length((modelViewMatrix * vec4(position, 1.0)).xyz);')
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vDistrictPosition;\nvarying float vDatumDistance;').replace('#include <color_fragment>', `#include <color_fragment>
      float presence = mix(0.48, 0.035, smoothstep(140.0, 600.0, vDatumDistance));
      diffuseColor.a *= smoothstep(0.018, 1.2, vDistrictPosition.y) * presence;
      vec2 coord = vDistrictPosition.xz / 24.0;
      vec2 cells = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), vec2(0.001));
      float datum = 1.0 - min(min(cells.x, cells.y), 1.0);
      diffuseColor.rgb += vec3(0.003, 0.006, 0.009) * datum;
    `)
  }
  material.customProgramCacheKey = () => 'wv-spatial-neighborhood-datum-v4'
  return material
}

function contourGeometry(plan: SpatialGroundPlan, district: GroundDistrict, factor: number): BufferGeometry {
  const points: number[] = []
  for (let i = 0; i < 100; i++) {
    const angle = i / 100 * Math.PI * 2
    const x = district.x + Math.cos(angle) * district.radius * factor
    const z = district.z + Math.sin(angle) * district.radius * factor
    points.push(x, groundYAt(plan, x, z) + .08, z)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3))
  return geometry
}

function District({ district, index, plan, showLabel }: { district: GroundDistrict; index: number; plan: SpatialGroundPlan; showLabel: boolean }) {
  const settings = useWorld((s) => s.settings)
  const [born, setBorn] = useState(0)
  const sampled = useRef(-Infinity)
  const last = useRef(-1)
  const color = COLORS[index % COLORS.length]
  const contours = useMemo(() => [1.15].map((factor) => {
    const material = new LineBasicMaterial({ color, transparent: true, opacity: .055, depthWrite: false })
    const line = new LineLoop(contourGeometry(plan, district, factor), material)
    line.layers.set(LAYER.DUST)
    return line
  }), [plan, district, color])
  useEffect(() => () => { for (const line of contours) { line.geometry.dispose(); line.material.dispose() } }, [contours])
  useFrame(({ clock }) => {
    if (!showLabel || !settings || clock.elapsedTime - sampled.current < .25) return
    sampled.current = clock.elapsedTime
    const poses = getPoseTable()
    let count = 0
    for (const id of district.memberIds) {
      const row = poses.index.get(id)
      if (row !== undefined && poses.born[row]) count++
    }
    if (count !== last.current) { last.current = count; setBorn(count) }
  })
  const open = () => exploreDistrict(plan, district)
  const cluster = plan.world.clusters.find((cluster) => cluster.id === district.id)
  const labelY = (cluster?.center[1] ?? 60) + Math.min(50, (cluster?.radius ?? 50) * .3) + 12
  return <group name={`knowledge-neighborhood-${district.id}`}>
    {contours.map((line, i) => <primitive key={i} object={line} raycast={() => {}} />)}
    {showLabel && <Html position={[district.x, labelY, district.z]} center zIndexRange={[2, 0]}>
      <button className="knowledge-district-label" style={{ borderColor: color + '70' }} onClick={(e) => { e.stopPropagation(); open() }} title={`Explore ${district.label}: ${district.count} saved notes, ${district.connections} connections`}><strong>{district.label}</strong><span>{born} / {district.count} notes at this date · {district.connections} {district.connections === 1 ? 'link' : 'links'}</span></button>
    </Html>}
  </group>
}

/** Broad connected ground follows actual 3D clusters. Time is carried by the timeline. */
export function KnowledgeGround() {
  const nodes = useWorld((s) => s.nodes)
  const settings = useWorld((s) => s.settings)
  const selectedId = useApp((s) => s.selectedId)
  const hidden = useApp((s) => ['entering', 'interior', 'exiting', 'framing'].includes(s.mode))
  const plan = useMemo(() => spatialGroundFor(nodes), [nodes])
  const surface = useMemo(() => createSurface(plan), [plan])
  const material = useMemo(createGroundMaterial, [])
  useEffect(() => () => surface.dispose(), [surface])
  useEffect(() => () => material.dispose(), [material])
  const pedestals = useRef<InstancedMesh>(null)
  const waves = useRef<InstancedMesh>(null)
  const flowTime = useRef(0)
  const engagement = useRef({ id: null as string | null, at: -Infinity })
  const scratch = useMemo(() => ({ object: new Object3D(), point: new Vector3() }), [])
  const [visibleLabels, setVisibleLabels] = useState<ReadonlySet<string>>(() => new Set())
  const labelState = useRef({ sampled: -Infinity, key: '', ids: new Set<string>() })
  const records = useMemo(() => [...nodes.values()].filter((n) => n.deletedAt === null), [nodes])
  const beams = useMemo(() => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, records.length) * 6), 3).setUsage(DynamicDrawUsage))
    geometry.setDrawRange(0, 0)
    const lineMaterial = new LineBasicMaterial({ color: new Color('#81a9c0'), transparent: true, opacity: .04, depthWrite: false })
    const lines = new LineSegments(geometry, lineMaterial)
    lines.frustumCulled = false; lines.layers.set(LAYER.DUST)
    return lines
  }, [records.length])
  useEffect(() => () => { beams.geometry.dispose(); beams.material.dispose() }, [beams])

  useFrame(({ camera, clock, size, gl }, delta) => {
    if (sceneMotionEnabled()) flowTime.current += Math.min(delta, .1)
    const t = flowTime.current
    const table = getPoseTable()
    const attr = beams.geometry.getAttribute('position') as BufferAttribute
    const epoch = settings ? playheadEpoch(settings) : Date.now()
    let pillars = 0, segments = 0, waveDots = 0
    if (selectedId !== engagement.current.id) engagement.current = { id: selectedId, at: t }
    const addWave = (id: string, progress: number, opacity: number) => {
      const point = plan.world.positions.get(id)
      const clusterId = plan.world.clusterOf.get(id)
      const district = plan.districts.find((d) => d.id === clusterId)
      if (!point || !district || !waves.current) return
      const radius = (4 + progress * Math.min(140, district.radius * 1.3))
      for (let i = 0; i < 80 && waveDots < MAX_WAVE_DOTS; i++) {
        const angle = i / 80 * Math.PI * 2 + t * .05
        const x = point[0] + Math.cos(angle) * radius, z = point[2] + Math.sin(angle) * radius
        const y = groundYAt(plan, x, z)
        if (y < .35 || Math.hypot(x - district.x, z - district.z) > district.outerRadius) continue
        scratch.object.position.set(x, y + .6 + Math.sin(angle * 3 + t) * .18, z)
        scratch.object.scale.setScalar(Math.max(.05, opacity) * (.7 + .2 * Math.sin(i * 2.4)))
        scratch.object.updateMatrix(); waves.current.setMatrixAt(waveDots++, scratch.object.matrix)
      }
    }
    for (const record of records) {
      const row = table.index.get(record.id)
      if (row === undefined || table.born[row] !== 1) continue
      const i = row * 3, x = table.pos[i], y = table.pos[i + 1], z = table.pos[i + 2]
      const floor = groundYAt(plan, x, z)
      const height = .45
      scratch.object.position.set(x, floor + height / 2, z)
      scratch.object.scale.set(1 + Math.sqrt(record.thermo.mass) * .35, height, 1 + Math.sqrt(record.thermo.mass) * .35)
      scratch.object.updateMatrix(); pedestals.current?.setMatrixAt(pillars++, scratch.object.matrix)
      attr.setXYZ(segments++, x, floor + height, z); attr.setXYZ(segments++, x, Math.max(floor + height, y - 3), z)
      const birthPhase = groundBirthPhase(record, epoch)
      if (birthPhase !== null && waveDots < MAX_WAVE_DOTS - 80) addWave(record.id, birthPhase, Math.sin(Math.PI * birthPhase) * .9)
    }
    if (engagement.current.id && t - engagement.current.at < 7) {
      const id = engagement.current.id, row = table.index.get(id)
      if (row !== undefined && table.born[row] === 1) {
        const progress = (t - engagement.current.at) / 7
        addWave(id, progress, Math.sin(Math.PI * progress) * 1.2)
      }
    }
    if (pedestals.current) { pedestals.current.count = pillars; pedestals.current.instanceMatrix.needsUpdate = true }
    if (waves.current) { waves.current.count = waveDots; waves.current.instanceMatrix.needsUpdate = true }
    attr.needsUpdate = true; beams.geometry.setDrawRange(0, segments)
    if (!hidden && clock.elapsedTime - labelState.current.sampled >= .4) {
      const state = labelState.current; state.sampled = clock.elapsedTime
      const candidates: DistrictLabelCandidate[] = []
      const nearby = plan.world.clusters.some((cluster) => scratch.point.fromArray(cluster.center).distanceTo(camera.position) < 180)
      const limit = size.width < 660 ? 2 : nearby ? 5 : 3
      const canvas = gl.domElement.getBoundingClientRect()
      const agents = [...document.querySelectorAll<HTMLElement>('.world-agent-label')].map((label) => label.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0)
      for (const district of plan.districts) {
        const cluster = plan.world.clusters.find((cluster) => cluster.id === district.id)
        const labelY = (cluster?.center[1] ?? 60) + Math.min(50, (cluster?.radius ?? 50) * .3) + 12
        scratch.point.set(district.x, labelY, district.z).project(camera)
        if (scratch.point.z < -1 || scratch.point.z > 1) continue
        const x = (scratch.point.x + 1) * size.width / 2, y = (1 - scratch.point.y) * size.height / 2
        const margin = Math.min(90, size.width / 3)
        if (x < margin || x > size.width - margin || y < 115 || y > size.height - (size.width < 660 ? 200 : 150)) continue
        if (agents.some((rect) => x + canvas.left + 95 > rect.left - 6 && x + canvas.left - 95 < rect.right + 6 && y + canvas.top + 25 > rect.top - 90 && y + canvas.top - 25 < rect.bottom + 6)) continue
        candidates.push({ id: district.id, count: district.count, x, y })
      }
      const chosen = chooseDistrictLabels(candidates, state.ids, limit)
      const key = chosen.join('|')
      if (key !== state.key) { state.key = key; state.ids = new Set(chosen); setVisibleLabels(state.ids) }
    }
  }, -.7)
  const pickNeighborhood = (event: ThreeEvent<MouseEvent>) => {
    const district = plan.districts.find((d) => Math.hypot(event.point.x - d.x, event.point.z - d.z) < d.radius)
    if (!district) return
    event.stopPropagation(); event.nativeEvent.stopImmediatePropagation()
    exploreDistrict(plan, district)
  }
  if (hidden) return null
  return <group name="knowledge-ground">
    <mesh geometry={surface} material={material} onClick={pickNeighborhood} />
    <primitive object={beams} raycast={() => {}} />
    <instancedMesh ref={pedestals} args={[undefined, undefined, Math.max(1, records.length)]} frustumCulled={false} raycast={() => {}}><cylinderGeometry args={[1.6, 1.6, 1, 24]} /><meshStandardMaterial color="#0b1b28" roughness={.98} metalness={0} envMapIntensity={.02} transparent opacity={.22} depthWrite={false} /></instancedMesh>
    <instancedMesh ref={waves} args={[undefined, undefined, MAX_WAVE_DOTS]} frustumCulled={false} raycast={() => {}}><sphereGeometry args={[1.1, 7, 5]} /><meshBasicMaterial color="#9ac9d8" transparent opacity={.65} toneMapped={false} depthWrite={false} /></instancedMesh>
    {plan.districts.map((district, index) => <District key={district.id} district={district} index={index} plan={plan} showLabel={visibleLabels.has(district.id)} />)}
  </group>
}
