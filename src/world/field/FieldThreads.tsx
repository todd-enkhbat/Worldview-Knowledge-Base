import { useEffect, useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, LineSegments, ShaderMaterial, type IUniform } from 'three'
import { buildTypedLinks } from '../links/style.ts'
import { LAYER } from '../layers.ts'
import { getFieldFrame } from './runtime.ts'

const THREAD_VERT = /* glsl */ `
uniform sampler2D uNotes;
uniform float uN;
uniform float uTime;
attribute vec2 aEnds;
attribute float aT;
varying float vT;
varying float vAlpha;
vec4 note(float i, float row) { return texture2D(uNotes, vec2((i + 0.5) / uN, row)); }
void main() {
  vec4 a = note(aEnds.x, 1.0 / 6.0);
  vec4 b = note(aEnds.y, 1.0 / 6.0);
  vec4 sa = note(aEnds.x, 0.5);
  vec4 sb = note(aEnds.y, 0.5);
  float len = distance(a.xyz, b.xyz);
  vec3 mid = mix(a.xyz, b.xyz, 0.5) + vec3(0.0, 2.0 + len * 0.22, 0.0);
  vec3 p = mix(mix(a.xyz, mid, aT), mix(mid, b.xyz, aT), aT);
  vT = aT;
  vAlpha = min(sa.y, sb.y) * (0.4 + 0.5 * max(sa.z, sb.z));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`
const THREAD_FRAG = /* glsl */ `
uniform float uTime;
varying float vT;
varying float vAlpha;
void main() {
  float pulse = pow(max(0.0, cos(vT * 18.0 - uTime * 0.8)), 8.0);
  gl_FragColor = vec4(vec3(1.52, 1.18, 0.54) * (0.7 + pulse * 0.65), vAlpha);
}
`

/** The continuous paths make a relationship readable between the moving current grains. */
export function FieldThreads({ structure, uniforms }: { structure: number; uniforms: Record<string, IUniform> }) {
  const resources = useMemo(() => {
    void structure
    const frame = getFieldFrame()
    const links = buildTypedLinks(new Map(frame.records.map((r) => [r.id, r])))
    const segments = Math.min(32, Math.max(8, Math.floor(60000 / Math.max(1, links.length))))
    const count = links.length * segments * 2
    const ends = new Float32Array(count * 2)
    const t = new Float32Array(count)
    let n = 0
    for (const link of links) for (let j = 0; j < segments; j++) for (let k = 0; k < 2; k++, n++) {
      ends.set([frame.index.get(link.from)!, frame.index.get(link.to)!], n * 2)
      t[n] = (j + k) / segments
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aEnds', new BufferAttribute(ends, 2))
    g.setAttribute('aT', new BufferAttribute(t, 1))
    const m = new ShaderMaterial({ uniforms, vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending })
    const lines = new LineSegments(g, m)
    lines.layers.set(LAYER.SOLID)
    lines.frustumCulled = false
    lines.raycast = () => {}
    return { g, m, lines }
  }, [structure, uniforms])
  useEffect(() => () => { resources.g.dispose(); resources.m.dispose() }, [resources])
  return <primitive name="field-threads" object={resources.lines} />
}
