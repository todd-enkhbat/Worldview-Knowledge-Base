import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, CircleGeometry, Group, Mesh, MeshBasicMaterial, Points, SRGBColorSpace, ShaderMaterial, Vector3, VideoTexture } from 'three'
import { useWorld } from '../../app/store.ts'
import { registerDevApi } from '../../app/devApi.ts'
import type { Attachment, NodeRecord } from '../../domain/types.ts'
import { useStoredBlobUrl } from '../../hud/fields/SceneField.tsx'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { DIORAMA_HALF, Diorama, getDiorama } from '../splats/index.tsx'
import { getFieldFrame, type FieldFrame } from './runtime.ts'
import { sceneStand } from './state.ts'

// Spaces and moving pictures in the field (milestone 2): notes that hold a captured scene
// or a video show it, the closer you come the more.
//   scenes  a memory's Gaussian-splat diorama condenses out of its note: from afar the note is
//           a cloud in the scene's colours over land stained by them; coming near, the scene
//           fades in standing on a levelled clearing, its edge a soft round rim that dissolves
//           into the grains (no case, no box), while the cloud thins away. Double-click to walk
//           in (FieldPicker → flyIn).
//   videos  a card of grains that samples the playing video (muted, looping), facing you.
//           Only the nearest few play; the rest show nothing beyond their cloud.

/** Within NEAR_D a scene is fully present and its cloud gone; beyond FAR_D it is only colour. */
const NEAR_D = 45
const FAR_D = 150
const MAX_VIDEOS = 3
const VIDEO_PLAY_D = 140
const VIDEO_COLS = 96

const _v = new Vector3()

/** Live video cards (dev hook __wv.fieldMedia()). */
const liveVideos = new Map<string, { video: HTMLVideoElement; show: () => number; url: () => string | null }>()
export function fieldMediaStatus() {
  return [...liveVideos].map(([id, v]) => ({
    id,
    url: !!v.url(),
    paused: v.video.paused,
    readyState: v.video.readyState,
    size: [v.video.videoWidth, v.video.videoHeight],
    time: Math.round(v.video.currentTime * 100) / 100,
    show: Math.round(v.show() * 100) / 100,
  }))
}

/** 0 far … 1 near, from camera distance, eased. */
export function nearness(d: number): number {
  const t = 1 - Math.min(1, Math.max(0, (d - NEAR_D) / (FAR_D - NEAR_D)))
  return t * t * (3 - 2 * t)
}

// ─── scenes ──────────────────────────────────────────────────────────────────────────

export interface SceneFootprint {
  x: number
  z: number
  /** Radius of the scene's shell on the land (world units). */
  radius: number
  /** Land height the scene stands on: the land is levelled to it around the scene. */
  ground: number
  /** 0 … 1: how present the scene is (nearness × condensation). */
  presence: number
}

/** Where a born scene note stands, for the scene itself and for the land it levels and stains. */
export function sceneFootprint(f: FieldFrame, i: number, cam: Vector3): SceneFootprint {
  const x = f.centers[i * 3]
  const z = f.centers[i * 3 + 2]
  const c = f.condense[i]
  const { radius, ground } = sceneStand(f.heightfield, x, z, c)
  _v.set(x, f.centers[i * 3 + 1], z)
  return {
    x,
    z,
    radius,
    ground,
    presence: nearness(_v.distanceTo(cam)) * (0.85 + 0.15 * c),
  }
}

/** Scenes standing in the field (dev hook __wv.fieldScenes()). */
const sceneStatus = new Map<string, () => unknown>()
registerDevApi('fieldScenes', () => [...sceneStatus].map(([id, f]) => ({ id, ...(f() as object) })))

function FieldScene({ rec }: { rec: NodeRecord }) {
  const group = useRef<Group>(null)
  const last = useRef<SceneFootprint | null>(null)
  // A depth-only disc just under the ground beneath the scene. Splats write no depth and the
  // land is grains with gaps, so post fog took most of a scene for distant sky and darkened it.
  // Round and inside the scene's footprint, it leaves no edge of its own.
  const plate = useMemo(() => {
    const m = new Mesh(new CircleGeometry(1, 48), new MeshBasicMaterial({ colorWrite: false }))
    m.rotation.x = -Math.PI / 2
    m.renderOrder = RENDER_ORDER.DEPTH_PROXY
    m.layers.set(LAYER.SOLID)
    m.raycast = () => {}
    m.name = 'field-scene-plate'
    return m
  }, [])
  useEffect(
    () => () => {
      plate.geometry.dispose()
      ;(plate.material as MeshBasicMaterial).dispose()
    },
    [plate],
  )
  useEffect(() => {
    sceneStatus.set(rec.id, () => {
      const d = getDiorama(rec.id)
      const g = group.current
      return {
        title: rec.title,
        footprint: last.current,
        shape: d?.shape(),
        at: g ? [g.position.x, g.position.y, g.position.z].map((v) => Math.round(v * 10) / 10) : null,
        scale: g?.scale.x,
        proxy: d?.proxy ? { visible: d.proxy.visible, opacity: d.proxy.opacity } : null,
        rim: d?.rimStatus(),
      }
    })
    return () => void sceneStatus.delete(rec.id)
  }, [rec.id, rec.title])

  useFrame((state) => {
    const g = group.current
    if (!g) return
    const f = getFieldFrame()
    const i = f.index.get(rec.id)
    const d = getDiorama(rec.id)
    if (i === undefined || !f.born[i]) {
      g.visible = false
      plate.visible = false
      d?.setFieldLook(true, 0)
      return
    }
    g.visible = true
    const fp = sceneFootprint(f, i, state.camera.position)
    last.current = fp
    const s = Math.max(1e-3, fp.radius / DIORAMA_HALF)
    // Stand just on the levelled ground: the floor covers the grains, the land runs on under it.
    const floor = (d?.shape().floor ?? 1) * fp.radius
    g.position.set(fp.x, fp.ground + floor + 0.25, fp.z)
    plate.visible = fp.presence > 0.3
    plate.position.set(fp.x, fp.ground - 0.3, fp.z)
    plate.scale.setScalar(fp.radius * 0.75)
    g.scale.setScalar(s)
    d?.setFieldLook(true, fp.presence)
  }, -1)

  // No depth box here: one cut a hard-edged clearing into the fog. The plate stands in.
  return (
    <>
      <group ref={group} name="field-scene" userData={{ nodeId: rec.id }}>
        <Diorama id={rec.id} block={rec.splat!} />
      </group>
      <primitive object={plate} />
    </>
  )
}

/** How much a scene note's cloud should thin (0 none … 1 gone), by id, for FieldLayer. */
export function sceneReveal(rec: NodeRecord, dist: number): number {
  return rec.splat ? Math.min(1, 1.2 * nearness(dist)) : 0
}

export function FieldScenes() {
  const nodes = useWorld((s) => s.nodes)
  const scenes = useMemo(() => [...nodes.values()].filter((r) => r.deletedAt === null && r.archetype === 'memory' && r.splat), [nodes])
  return (
    <group name="field-scenes">
      {scenes.map((r) => (
        <FieldScene key={r.id} rec={r} />
      ))}
    </group>
  )
}

// ─── videos ──────────────────────────────────────────────────────────────────────────

const VIDEO_VERT = /* glsl */ `
uniform sampler2D uNotes;
uniform float uN;
uniform float uNote;
uniform float uTime;
uniform float uPixel;
uniform float uAspect;
uniform float uShow;
attribute vec2 aPlane;   // [-0.5, 0.5]²
attribute vec3 aJitter;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 a = texture2D(uNotes, vec2((uNote + 0.5) / uN, 1.0 / 6.0)); // centre, sigma
  vec4 b = texture2D(uNotes, vec2((uNote + 0.5) / uN, 0.5)); // order, born, highlight, condense
  if (b.y < 0.5 || uShow < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float order = b.x;
  vec4 c = modelViewMatrix * vec4(a.xyz + vec3(0.0, 2.5, 0.0), 1.0);
  float h = 6.0 * uShow;
  vec2 card = vec2(aPlane.x * h * uAspect, aPlane.y * h);
  // Neglected videos fray at the edges, like everything else that loses order.
  float fray = (1.0 - order) * (0.3 + length(aPlane)) * 1.5;
  vec3 drift = aJitter * fray + vec3(sin(uTime * 0.6 + aJitter.x * 9.0), cos(uTime * 0.5 + aJitter.y * 7.0), 0.0) * 0.04;
  vec4 mv = c + vec4(card + drift.xy, drift.z, 0.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((h / ${VIDEO_COLS}.0) * 1.7 * uPixel / -mv.z, 1.0, 6.0);
  vUv = aPlane + 0.5;
  vAlpha = uShow;
}
`

const VIDEO_FRAG = /* glsl */ `
uniform sampler2D uVideo;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  if (dot(d, d) > 1.0) discard;
  if (vAlpha < 0.05) discard;
  vec3 c = texture2D(uVideo, vUv).rgb;
  gl_FragColor = vec4(c, 1.0);
}
`

function videoGrains(aspect: number): BufferGeometry {
  const cols = VIDEO_COLS
  const rows = Math.max(8, Math.round(cols / Math.max(0.3, aspect)))
  const n = cols * rows
  const plane = new Float32Array(n * 2)
  const jit = new Float32Array(n * 3)
  let k = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++, k++) {
      plane[k * 2] = (x + 0.5 + (Math.random() - 0.5) * 0.5) / cols - 0.5
      plane[k * 2 + 1] = (y + 0.5 + (Math.random() - 0.5) * 0.5) / rows - 0.5
      jit[k * 3] = Math.random() - 0.5
      jit[k * 3 + 1] = Math.random() - 0.5
      jit[k * 3 + 2] = Math.random() - 0.5
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('aPlane', new BufferAttribute(plane, 2))
  g.setAttribute('aJitter', new BufferAttribute(jit, 3))
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))
  return g
}

function FieldVideo({ rec, video: att, notes }: { rec: NodeRecord; video: Attachment; notes: { uNotes: { value: unknown }; uN: { value: number } } }) {
  const url = useStoredBlobUrl(att.blobId)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const [aspect, setAspect] = useState(16 / 9)
  const show = useRef(0)
  const lastTime = useRef(-1)

  const video = useMemo(() => {
    const v = document.createElement('video')
    v.muted = true
    v.loop = true
    v.playsInline = true
    v.preload = 'metadata'
    v.crossOrigin = 'anonymous'
    return v
  }, [])
  useEffect(() => {
    if (!url) return
    video.src = url
    const meta = () => video.videoWidth && setAspect(video.videoWidth / video.videoHeight)
    video.addEventListener('loadedmetadata', meta)
    return () => {
      video.removeEventListener('loadedmetadata', meta)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [url, video])

  useEffect(() => {
    liveVideos.set(rec.id, { video, show: () => show.current, url: () => url })
    return () => void liveVideos.delete(rec.id)
  }, [rec.id, video, url])

  const texture = useMemo(() => {
    const t = new VideoTexture(video)
    t.colorSpace = SRGBColorSpace
    return t
  }, [video])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VIDEO_VERT,
        fragmentShader: VIDEO_FRAG,
        uniforms: {
          uNotes: notes.uNotes,
          uN: notes.uN,
          uNote: { value: 0 },
          uTime: { value: 0 },
          uPixel: { value: 600 },
          uAspect: { value: 16 / 9 },
          uShow: { value: 0 },
          uVideo: { value: texture },
        },
        // Solid grains that write depth, like photo cards: post fog sees them as near.
        transparent: false,
        depthWrite: true,
      }),
    [notes, texture],
  )
  const points = useMemo(() => {
    const p = new Points(videoGrains(aspect), material)
    p.frustumCulled = false
    p.layers.set(LAYER.SOLID)
    p.raycast = () => {}
    p.name = 'field-video'
    return p
  }, [aspect, material])
  useEffect(() => () => points.geometry.dispose(), [points])
  useEffect(
    () => () => {
      material.dispose()
      texture.dispose()
    },
    [material, texture],
  )

  useFrame((state, dt) => {
    const f = getFieldFrame()
    const i = f.index.get(rec.id)
    const u = material.uniforms
    u.uTime.value = state.clock.elapsedTime
    u.uPixel.value = (size.height * dpr) / (2 * Math.tan(((state.camera as { fov?: number }).fov ?? 50) * (Math.PI / 360)))
    u.uAspect.value = aspect
    let want = 0
    if (i !== undefined && f.born[i]) {
      u.uNote.value = i
      _v.set(f.centers[i * 3], f.centers[i * 3 + 1], f.centers[i * 3 + 2])
      const d = _v.distanceTo(state.camera.position)
      want = d < VIDEO_PLAY_D ? f.condense[i] : 0
    }
    show.current += (want - show.current) * Math.min(1, dt * 3)
    u.uShow.value = show.current
    const playing = !video.paused
    if (want > 0 && url && !playing) void video.play().catch(() => {})
    else if (want === 0 && playing) video.pause()
    // Upload a frame whenever the video has moved on. VideoTexture's own frame callback is not
    // fired in throttled (hidden or background) views, which left cards black.
    if (video.readyState >= 2 && video.currentTime !== lastTime.current) {
      lastTime.current = video.currentTime
      texture.needsUpdate = true
    }
  }, -1)

  return <primitive object={points} />
}

/**
 * The nearest few born video notes play as grains. Which ones is re-decided a few times a
 * second; the rest are not mounted (no decoders, no textures).
 */
export function FieldVideos({ notes }: { notes: { uNotes: { value: unknown }; uN: { value: number } } }) {
  const nodes = useWorld((s) => s.nodes)
  const candidates = useMemo(() => {
    const out: { rec: NodeRecord; video: Attachment }[] = []
    for (const r of nodes.values()) {
      const v = r.deletedAt === null ? r.attachments.find((a) => a.mime.startsWith('video/')) : undefined
      if (v) out.push({ rec: r, video: v })
    }
    return out
  }, [nodes])
  const [active, setActive] = useState<string[]>([])
  const last = useRef(-Infinity)

  useFrame((state) => {
    const t = state.clock.elapsedTime
    if (t - last.current < 0.4) return
    last.current = t
    const f = getFieldFrame()
    const ranked = candidates
      .map((c) => {
        const i = f.index.get(c.rec.id)
        if (i === undefined || !f.born[i]) return null
        _v.set(f.centers[i * 3], f.centers[i * 3 + 1], f.centers[i * 3 + 2])
        return { id: c.rec.id, d: _v.distanceTo(state.camera.position) }
      })
      .filter((x): x is { id: string; d: number } => !!x && x.d < VIDEO_PLAY_D * 1.2)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_VIDEOS)
      .map((x) => x.id)
      .sort()
    if (ranked.join() !== active.join()) setActive(ranked)
  })

  return (
    <group name="field-videos">
      {candidates
        .filter((c) => active.includes(c.rec.id))
        .map((c) => (
          <FieldVideo key={c.rec.id} rec={c.rec} video={c.video} notes={notes} />
        ))}
    </group>
  )
}
