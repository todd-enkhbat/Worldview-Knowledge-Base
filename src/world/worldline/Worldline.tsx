import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Mesh, PerspectiveCamera, ShaderMaterial } from 'three'
import { useApp } from '../../app/store.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { refreshWorldline } from './live.ts'
import type { WorldlinePath } from './path.ts'

// The worldline ribbon: an emissive ember band through the memories in date order, rebuilt
// from the live pose table whenever it changes (render poses, so it follows the physics
// and the overlays). The band is camera-facing in the vertex shader (side = tangent ×
// view direction), with a floor of a couple of pixels so it still reads from across the
// column. Additive, depthWrite off, on LAYER.GLASS (main camera only: the reflector never
// sees it). Unborn stretches (memories after the playhead) fade to a ghost.

const EMBER = new Color('#e8b04a')
/** HDR gain: above the bloom threshold where the band is born. */
const GAIN = 2.4
/** Half-width in world units, and the screen-space floor in pixels. */
const HALF_WIDTH = 0.16
const MIN_HALF_PX = 1.25

const vertexShader = /* glsl */ `
attribute vec3 aTangent;
attribute float aSide;
attribute float aArc;
attribute float aBorn;
uniform float uHalfWidth;
uniform float uPxScale;
uniform float uMinHalfPx;
varying float vSide;
varying float vArc;
varying float vBorn;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 t = (modelViewMatrix * vec4(aTangent, 0.0)).xyz;
  vec3 side = cross(t, normalize(-mv.xyz));
  float l = length(side);
  side = l > 1e-5 ? side / l : vec3(1.0, 0.0, 0.0);
  float w = max(uHalfWidth, uMinHalfPx * uPxScale * max(-mv.z, 0.0));
  mv.xyz += side * aSide * w;
  vSide = aSide;
  vArc = aArc;
  vBorn = aBorn;
  gl_Position = projectionMatrix * mv;
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying float vSide;
varying float vArc;
varying float vBorn;
void main() {
  float edge = 1.0 - vSide * vSide;
  edge *= edge;
  // A slow pulse flowing in date order (≈ 18 u wavelength).
  float pulse = 0.5 + 0.5 * sin(vArc * 0.35 - uTime * 1.6);
  float k = mix(0.12, 1.0, vBorn) * (0.7 + 0.3 * pulse);
  gl_FragColor = vec4(uColor * (k * edge), 1.0);
}
`

class RibbonBuffers {
  readonly geometry = new BufferGeometry()
  private capacity = 0
  private builtVersion = -1

  /** Write the path into the vertex buffers (2 vertices per sample). */
  update(path: WorldlinePath): void {
    if (path.version === this.builtVersion) return
    this.builtVersion = path.version
    const n = path.count
    if (n > this.capacity) this.allocate(Math.max(n, Math.ceil(this.capacity * 1.5), 64))
    const g = this.geometry
    const pos = g.getAttribute('position') as BufferAttribute
    const tan = g.getAttribute('aTangent') as BufferAttribute
    const arc = g.getAttribute('aArc') as BufferAttribute
    const born = g.getAttribute('aBorn') as BufferAttribute
    const P = pos.array as Float32Array
    const T = tan.array as Float32Array
    const A = arc.array as Float32Array
    const B = born.array as Float32Array
    const s = path.samples
    for (let i = 0; i < n; i++) {
      const o = 3 * i
      // Central differences (one-sided at the ends).
      const a = 3 * Math.max(0, i - 1)
      const b = 3 * Math.min(n - 1, i + 1)
      let tx = s[b] - s[a]
      let ty = s[b + 1] - s[a + 1]
      let tz = s[b + 2] - s[a + 2]
      const l = Math.hypot(tx, ty, tz)
      if (l > 1e-9) {
        tx /= l
        ty /= l
        tz /= l
      } else {
        tx = 0
        ty = 1
        tz = 0
      }
      for (let v = 0; v < 2; v++) {
        const q = 2 * i + v
        P[3 * q] = s[o]
        P[3 * q + 1] = s[o + 1]
        P[3 * q + 2] = s[o + 2]
        T[3 * q] = tx
        T[3 * q + 1] = ty
        T[3 * q + 2] = tz
        A[q] = path.arc[i]
        B[q] = path.born[i]
      }
    }
    for (const attr of [pos, tan, arc, born]) {
      attr.clearUpdateRanges()
      attr.addUpdateRange(0, attr.itemSize * 2 * n)
      attr.needsUpdate = true
    }
    g.setDrawRange(0, n > 1 ? 6 * (n - 1) : 0)
  }

  private allocate(samples: number): void {
    const g = this.geometry
    const verts = 2 * samples
    g.setAttribute('position', new BufferAttribute(new Float32Array(3 * verts), 3))
    g.setAttribute('aTangent', new BufferAttribute(new Float32Array(3 * verts), 3))
    g.setAttribute('aArc', new BufferAttribute(new Float32Array(verts), 1))
    g.setAttribute('aBorn', new BufferAttribute(new Float32Array(verts), 1))
    const side = new Float32Array(verts)
    for (let q = 0; q < verts; q++) side[q] = q % 2 === 0 ? -1 : 1
    g.setAttribute('aSide', new BufferAttribute(side, 1))
    const index = new Uint32Array(6 * Math.max(0, samples - 1))
    for (let i = 0; i < samples - 1; i++) {
      const a = 2 * i
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], 6 * i)
    }
    g.setIndex(new BufferAttribute(index, 1))
    this.capacity = samples
    this.builtVersion = -1
  }

  dispose(): void {
    this.geometry.dispose()
  }
}

export interface WorldlineProps {
  /** Hide the ribbon (it still rebuilds, so autonav keeps a live path). */
  hidden?: boolean
}

export function Worldline({ hidden = false }: WorldlineProps) {
  const mode = useApp((s) => s.mode)
  const size = useThree((s) => s.size)
  const { buffers, material, mesh } = useMemo(() => {
    const buffers = new RibbonBuffers()
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: EMBER.clone().multiplyScalar(GAIN) },
        uTime: { value: 0 },
        uHalfWidth: { value: HALF_WIDTH },
        uPxScale: { value: 0 },
        uMinHalfPx: { value: MIN_HALF_PX },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    })
    const mesh = new Mesh(buffers.geometry, material)
    mesh.name = 'worldline'
    mesh.frustumCulled = false
    mesh.renderOrder = RENDER_ORDER.FRONT_SHELL
    mesh.layers.set(LAYER.GLASS)
    return { buffers, material, mesh }
  }, [])

  useEffect(
    () => () => {
      buffers.dispose()
      material.dispose()
    },
    [buffers, material],
  )

  // After the pose writer (−2): the poses this frame are final.
  useFrame((state) => {
    const path = refreshWorldline()
    buffers.update(path)
    const cam = state.camera
    material.uniforms.uTime.value = state.clock.elapsedTime
    const fov = cam instanceof PerspectiveCamera ? cam.fov : 50
    material.uniforms.uPxScale.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.height)
  }, -1)

  // The interior hides the world; the worldline is part of it.
  return <primitive object={mesh} visible={!hidden && mode !== 'interior'} />
}
