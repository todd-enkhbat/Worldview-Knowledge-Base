import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial } from 'three'
import { useWorld } from '../../app/store.ts'
import { getOverlayFields } from '../../overlay/index.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { capacityFor, farScale } from '../nodes/instancing.ts'
import { getPoseTable } from '../poses.ts'

// Per-node mist: long-unvisited, cold nodes (overlay/hebbian.ts mistAmount) sit inside a
// camera-facing veil of concrete-grey haze. The veil is drawn over the node, so it also
// washes the node's colour out: the desaturation hint. Instanced billboards; alpha ∝ mist.

/** Below this amount a node gets no veil. */
const MIN_MIST = 0.08
/** Veil radius at mist = 1 (world units, before the far-scale boost). */
const RADIUS = 2.6
const MAX_ALPHA = 0.5

const vertexShader = /* glsl */ `
attribute float aMist;
varying vec2 vUv;
varying float vMist;
void main() {
  vUv = uv;
  vMist = aMist;
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(instanceMatrix[0].xyz);
  center.xy += position.xy * s;
  gl_Position = projectionMatrix * center;
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uMaxAlpha;
varying vec2 vUv;
varying float vMist;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.15, 1.0, r)) * vMist * uMaxAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`

const _m = new Matrix4()

export function Mist() {
  const nodes = useWorld((s) => s.nodes)
  const geometry = useMemo(() => new PlaneGeometry(2, 2), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uColor: { value: new Color('#8d8a84').multiplyScalar(0.55) }, uMaxAlpha: { value: MAX_ALPHA } },
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  )
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  const capacity = Math.max(64, capacityFor(nodes.size))
  const mesh = useMemo(() => {
    const g = geometry.clone()
    const mist = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage)
    g.setAttribute('aMist', mist)
    const m = new InstancedMesh(g, material, capacity)
    m.name = 'mist'
    m.instanceMatrix.setUsage(DynamicDrawUsage)
    m.layers.set(LAYER.GLASS)
    m.renderOrder = RENDER_ORDER.FRONT_SHELL
    m.frustumCulled = false
    m.count = 0
    return m
  }, [geometry, material, capacity])
  useEffect(
    () => () => {
      mesh.geometry.dispose()
      mesh.dispose()
    },
    [mesh],
  )

  useFrame((state) => {
    const f = getOverlayFields(Date.now())
    const table = getPoseTable()
    const cam = state.camera.position
    const attr = mesh.geometry.getAttribute('aMist') as InstancedBufferAttribute
    const arr = attr.array as Float32Array
    let n = 0
    for (const [id, p] of f.nodes) {
      if (p.mist < MIN_MIST || n >= capacity) continue
      const row = table.index.get(id)
      if (row === undefined) continue
      const o = row * 3
      const x = table.pos[o]
      const y = table.pos[o + 1]
      const z = table.pos[o + 2]
      const s = RADIUS * (0.7 + 0.3 * p.mist) * farScale(Math.hypot(x - cam.x, y - cam.y, z - cam.z))
      _m.makeScale(s, s, s).setPosition(x, y, z)
      mesh.setMatrixAt(n, _m)
      // Ghosts (unborn at the playhead) carry a fainter veil.
      arr[n] = table.born[row] === 1 ? p.mist : p.mist * 0.35
      n++
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    attr.needsUpdate = true
  }, -1)

  return <primitive object={mesh} />
}
