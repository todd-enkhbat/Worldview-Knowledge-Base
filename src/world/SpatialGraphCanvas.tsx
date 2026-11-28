import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import { BufferAttribute, BufferGeometry, Color, InstancedMesh, Object3D, Vector3 } from 'three'
import type { GraphEdge, GraphNode } from '../reading/graphModel.ts'
import { graphEdgeColor, graphNodeKind, type Point3 } from './spatialGraph.ts'

export const graphColors = { topic: '#ffd189', source: '#6adfcf', writing: '#c1b0fb' }
type Layout = { positions: Map<string, Point3>; radius: number }
export type GraphCameraCommand = { action: 'fit' | 'focus' | 'left' | 'right' | 'up' | 'down' | 'in' | 'out'; key?: string; animate: boolean }
type GraphCanvasProps = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout: Layout
  labels: GraphNode[]
  selected?: string
  neighbors: Set<string>
  command: GraphCameraCommand
  reduced: boolean
  onSelect: (key: string, animate: boolean) => void
}

function Camera({ command, layout, reduced }: Pick<GraphCanvasProps, 'command' | 'layout' | 'reduced'>) {
  const controls = useRef<CameraControls>(null)
  const { width, height } = useThree(state => state.size)
  const aspect = useRef(width / Math.max(1, height))
  aspect.current = width / Math.max(1, height)

  useLayoutEffect(() => {
    const view = controls.current
    if (!view) return
    const move = command.animate && !reduced
    if (command.action === 'fit') {
      const distance = layout.radius * (aspect.current < 0.85 ? 3.1 / Math.max(0.45, aspect.current) : 2.9)
      void view.setLookAt(distance * 0.29, distance * 0.18, distance * 0.94, 0, 0, 0, move)
    } else if (command.action === 'focus') {
      const point = command.key && layout.positions.get(command.key)
      if (!point) return
      const offset = view.getPosition(new Vector3()).sub(view.getTarget(new Vector3()))
      const distance = Math.max(15, Math.min(36, layout.radius * 1.16))
      offset.setLength(distance).add(new Vector3(...point))
      void view.setLookAt(offset.x, offset.y, offset.z, ...point, move)
    }
  }, [command, layout, reduced])

  useLayoutEffect(() => {
    const view = controls.current
    if (!view) return
    const move = command.animate && !reduced
    if (command.action === 'in' || command.action === 'out') {
      const distance = view.getDistanceToFitSphere(2) * 0.045 + view.distance * 0.18
      void view.dolly(command.action === 'in' ? distance : -distance, move)
    }
    if (command.action === 'left' || command.action === 'right') void view.rotate(command.action === 'left' ? -0.18 : 0.18, 0, move)
    if (command.action === 'up' || command.action === 'down') void view.rotate(0, command.action === 'up' ? -0.16 : 0.16, move)
  }, [command, reduced])

  return <CameraControls ref={controls} smoothTime={0.24} draggingSmoothTime={reduced ? 0.01 : 0.1}
    minDistance={1.8} maxDistance={layout.radius * 11} dollySpeed={0.76} />
}

function Spheres({ nodes, layout, selected, neighbors, onSelect }: Pick<GraphCanvasProps, 'nodes' | 'layout' | 'selected' | 'neighbors' | 'onSelect'>) {
  const mesh = useRef<InstancedMesh>(null)
  const { gl, invalidate } = useThree()
  useLayoutEffect(() => {
    const target = mesh.current
    if (!target) return
    const transform = new Object3D(), color = new Color()
    const scale = Math.min(1.9, Math.max(0.82, layout.radius / 37))
    nodes.forEach((node, index) => {
      const kind = graphNodeKind(node)
      const active = node.key === selected
      const dim = selected && !active && !neighbors.has(node.key)
      const radius = (active ? 0.78 : kind === 'topic' ? 0.52 : kind === 'writing' ? 0.46 : 0.38) * scale
      transform.position.set(...layout.positions.get(node.key)!)
      transform.scale.setScalar(radius)
      transform.updateMatrix()
      target.setMatrixAt(index, transform.matrix)
      target.setColorAt(index, color.set(graphColors[kind]).multiplyScalar(dim ? 0.25 : 1))
    })
    target.instanceMatrix.needsUpdate = true
    if (target.instanceColor) target.instanceColor.needsUpdate = true
    target.computeBoundingSphere()
    invalidate()
  }, [nodes, layout, selected, neighbors, invalidate])
  useLayoutEffect(() => () => { gl.domElement.style.cursor = '' }, [gl])
  if (!nodes.length) return null
  return <instancedMesh ref={mesh} args={[undefined, undefined, nodes.length]}
    onClick={(event) => {
      const node = event.instanceId === undefined ? undefined : nodes[event.instanceId]
      if (!node || event.delta > 5) return
      event.stopPropagation()
      onSelect(node.key, true)
    }}
    onPointerOver={(event) => { event.stopPropagation(); gl.domElement.style.cursor = 'pointer' }}
    onPointerOut={() => { gl.domElement.style.cursor = '' }}>
    <sphereGeometry args={[1, 12, 8]} />
    <meshStandardMaterial roughness={0.47} metalness={0.08} toneMapped={false} />
  </instancedMesh>
}

function Connections({ edges, layout, selected }: Pick<GraphCanvasProps, 'edges' | 'layout' | 'selected'>) {
  const geometry = useMemo(() => {
    const pairCounts = new Map<string, number>()
    const pairKey = (edge: GraphEdge) => JSON.stringify(edge.from < edge.to ? [edge.from, edge.to] : [edge.to, edge.from])
    for (const edge of edges) {
      const key = pairKey(edge)
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
    }
    const parallelIndex = new Map<string, number>()
    const segments = 8
    const positions = new Float32Array(edges.length * segments * 6), colors = new Float32Array(positions.length)
    const color = new Color(), from = new Vector3(), to = new Vector3(), span = new Vector3()
    const normal = new Vector3(), up = new Vector3(0, 1, 0), side = new Vector3(1, 0, 0)
    const start = new Vector3(), end = new Vector3()
    edges.forEach((edge, index) => {
      const pair = pairKey(edge), count = pairCounts.get(pair)!
      const ordinal = parallelIndex.get(pair) ?? 0
      parallelIndex.set(pair, ordinal + 1)
      from.set(...layout.positions.get(edge.from)!)
      to.set(...layout.positions.get(edge.to)!)
      span.subVectors(to, from).normalize().multiplyScalar(edge.from < edge.to ? 1 : -1)
      normal.crossVectors(span, Math.abs(span.y) > 0.87 ? side : up).normalize()
      const bend = (ordinal - (count - 1) / 2) * Math.min(0.75, 4 / count)
      const incident = selected === edge.from || selected === edge.to
      const brightness = selected ? incident ? 1 : 0.13 : edge.origin === 'tag' ? 0.54 : 0.9
      color.set(graphEdgeColor(edge)).multiplyScalar(brightness)
      const components = [color.r, color.g, color.b, color.r, color.g, color.b]
      start.copy(from)
      for (let segment = 0; segment < segments; segment++) {
        const t = (segment + 1) / segments
        const at = (index * segments + segment) * 6
        end.lerpVectors(from, to, t).addScaledVector(normal, bend * 4 * t * (1 - t))
        start.toArray(positions, at)
        end.toArray(positions, at + 3)
        colors.set(components, at)
        start.copy(end)
      }
    })
    return new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3))
      .setAttribute('color', new BufferAttribute(colors, 3))
  }, [edges, layout, selected])
  useLayoutEffect(() => () => geometry.dispose(), [geometry])
  return <lineSegments geometry={geometry}>
    <lineBasicMaterial vertexColors transparent opacity={0.64} depthWrite={false} toneMapped={false} />
  </lineSegments>
}

function ProjectLabels({ labels, layout, selected, elements }: Pick<GraphCanvasProps, 'labels' | 'layout' | 'selected'> & { elements: RefObject<Map<string, HTMLButtonElement>> }) {
  const projected = useMemo(() => new Vector3(), [])
  useFrame(({ camera, size }) => {
    const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = []
    const budget = size.width < 520 ? 7 : 20
    for (const node of labels) {
      const element = elements.current.get(node.key)
      if (!element) continue
      projected.set(...layout.positions.get(node.key)!).project(camera)
      const x = (projected.x + 1) * size.width / 2, y = (1 - projected.y) * size.height / 2
      const width = Math.min(size.width - 32, Math.min(190, Math.max(40, node.title.length * 7.5 + 25)))
      const left = Math.round(Math.min(size.width - width - 7, Math.max(7, x - width / 2)))
      const top = Math.round(y + (node.key === selected ? 23 : 16))
      const box = { left, top, right: left + width, bottom: top + 25 }
      const visible = occupied.length < budget && projected.z > -1 && projected.z < 1
        && x > 5 && x < size.width - 5 && y > 6 && box.bottom < size.height - 6
        && !occupied.some(other => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 3 && box.bottom > other.top - 3)
      element.style.visibility = visible ? 'visible' : 'hidden'
      if (!visible) continue
      occupied.push(box)
      element.style.width = width + 'px'
      element.style.transform = `translate(${left}px, ${top}px)`
    }
  })
  return null
}

export default function SpatialGraphCanvas(props: GraphCanvasProps) {
  const labelElements = useRef(new Map<string, HTMLButtonElement>())
  return <div className="spatial-viewport">
    <Canvas className="spatial-canvas" frameloop="demand" dpr={[1, 1.75]} camera={{ fov: 42, near: 0.05, far: Math.max(3000, props.layout.radius * 40) }}
      gl={{ alpha: true, antialias: true }} fallback={<p className="spatial-stage-message">Open the 2D graph on a device without WebGL.</p>}>
      <ambientLight intensity={1.65} />
      <directionalLight position={[8, 14, 12]} color="#d8edff" intensity={2.4} />
      <directionalLight position={[-9, 2, -10]} color="#a999f4" intensity={1.2} />
      <Camera command={props.command} layout={props.layout} reduced={props.reduced} />
      <Connections edges={props.edges} layout={props.layout} selected={props.selected} />
      <Spheres nodes={props.nodes} layout={props.layout} selected={props.selected} neighbors={props.neighbors} onSelect={props.onSelect} />
      <ProjectLabels labels={props.labels} layout={props.layout} selected={props.selected} elements={labelElements} />
    </Canvas>
    <div className="spatial-labels" aria-hidden="true">
      {props.labels.map(node => <button key={node.key} ref={element => {
        if (element) labelElements.current.set(node.key, element)
        else labelElements.current.delete(node.key)
      }} type="button" tabIndex={-1} className="spatial-label" data-selected={node.key === props.selected}
        data-kind={graphNodeKind(node)} onClick={() => props.onSelect(node.key, true)}>{node.title}</button>)}
    </div>
  </div>
}
