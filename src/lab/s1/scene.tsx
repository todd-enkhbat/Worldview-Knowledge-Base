import { useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MeshReflectorMaterial, OrbitControls } from '@react-three/drei'
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import {
  AdditiveBlending,
  AgXToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  HalfFloatType,
  Points,
  PointsMaterial,
  Vector3,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { SparkRenderer } from '@sparkjsdev/spark'
import { enableMainCameraLayers, LAYER, RENDER_ORDER } from '../../world/layers.ts'
import { LinearDepthEffect } from './depthView.ts'
import { Diorama, setSplatLayer } from './diorama.ts'
import { MovingLod, TweenStage } from './extras.ts'
import { FIXTURES } from './fixtures.ts'
import { BOX_HALF } from './glass.ts'
import { FLAG } from './metrics.ts'
import { pathPose } from './path.ts'
import { attachSparkProbe, sparkCounts } from './sparkProbe.ts'
import { rt, useS1 } from './state.ts'

// The S1 scene: exactly one SparkRenderer (added to the scene as an object), four clipped
// dioramas with proxies, a reflector floor, threshold bloom through a HalfFloat composer,
// 100k dust points, the #347 moving LoD mesh and the fly-in proxy tween.

const FRAME_BEGIN = -10_000
const FRAME_END = 10_000
const PATH_PRIORITY = -5

interface World {
  spark: SparkRenderer
  root: Group
  dioramas: Diorama[]
  moving: MovingLod
  stage: TweenStage
  dispose(): void
}

function createWorld(gl: WebGLRenderer, scene: Scene): World {
  const t = useS1.getState().toggles
  const spark = new SparkRenderer({ renderer: gl })
  spark.renderOrder = RENDER_ORDER.SPLATS
  setSplatLayer(spark, t.leakSplats)
  spark.material.forceSinglePass = t.forceSinglePass
  const probe = attachSparkProbe(spark, gl, (c: Camera) => c === rt.camera)
  rt.spark = spark
  rt.probe = probe

  const root = new Group()
  root.add(spark)
  const dioramas = FIXTURES.map((spec, i) => {
    const x = -9 + 6 * i
    const d = new Diorama(i, spec, new Vector3(x, BOX_HALF + 0.2, 0), new Vector3(x, BOX_HALF + 0.2, -6.5))
    root.add(d.rowA, d.rowB)
    return d
  })
  const moving = new MovingLod()
  const stage = new TweenStage()
  root.add(moving.group, stage.group)
  scene.add(root)
  return {
    spark,
    root,
    dioramas,
    moving,
    stage,
    dispose() {
      scene.remove(root)
      probe.dispose()
      for (const d of dioramas) d.dispose()
      moving.dispose()
      stage.dispose()
      spark.dispose()
      if (rt.spark === spark) {
        rt.spark = null
        rt.probe = null
      }
    },
  }
}

function SparkWorld() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const [world, setWorld] = useState<World | null>(null)
  const toggles = useS1((s) => s.toggles)

  useEffect(() => {
    const w = createWorld(gl, scene)
    setWorld(w)
    // Deferred so StrictMode's mount → unmount → mount does not fetch everything twice.
    const timer = setTimeout(() => {
      // Large files one after another: parallel SOG decodes compete for the same workers.
      void (async () => {
        void w.moving.load()
        for (const d of w.dioramas) {
          if (d.disposed) return
          await d.load(w.spark)
        }
      })()
    }, 0)
    return () => {
      clearTimeout(timer)
      w.dispose()
      setWorld(null)
    }
  }, [gl, scene])

  useEffect(() => {
    if (!world) return
    world.spark.material.forceSinglePass = toggles.forceSinglePass
    setSplatLayer(world.spark, toggles.leakSplats)
    world.moving.setLeak(toggles.leakSplats)
    world.stage.setLeak(toggles.leakSplats)
    world.moving.group.visible = toggles.movingLod
    world.stage.group.visible = toggles.tween
    for (const d of world.dioramas) {
      d.setLeak(toggles.leakSplats)
      d.setDepthProxy(toggles.depthProxy, toggles.depthProxyEarly)
      d.setMode(toggles.dioramaMode, toggles.proxyMethod, world.spark)
    }
  }, [world, toggles])

  useFrame(() => {
    if (!world) return
    const t = performance.now() / 1000
    const tg = useS1.getState().toggles
    if (tg.movingLod) world.moving.update(t)
    // The tween borrows the apartment proxy ('cut') once it exists.
    const src = world.dioramas[2]
    const proxy = src?.proxies.get('cut')
    if (!world.stage.mesh && proxy && src.fit) void world.stage.attach(proxy.a, src.fit)
    rt.tweenActive = world.stage.update(t, tg.tween, world.spark)
  })
  return null
}

function Floor({ reflector }: { reflector: boolean }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={0}>
      <planeGeometry args={[160, 160]} />
      {reflector ? (
        <MeshReflectorMaterial
          resolution={1024}
          blur={[120, 40]}
          mixBlur={0.4}
          mixStrength={6}
          mirror={0.9}
          depthScale={0}
          color="#2a2a2c"
          metalness={0.7}
          roughness={0.6}
        />
      ) : (
        <meshStandardMaterial color="#1b1b1c" roughness={0.9} metalness={0.2} />
      )}
    </mesh>
  )
}

const DUST_COUNT = 100_000

function Dust() {
  const [points] = useState(() => {
    const pos = new Float32Array(DUST_COUNT * 3)
    let s = 0x1234567
    const rnd = () => {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      return (s >>> 0) / 4294967296
    }
    for (let i = 0; i < DUST_COUNT; i++) {
      pos[3 * i] = (rnd() - 0.5) * 70
      pos[3 * i + 1] = rnd() * 16
      pos[3 * i + 2] = (rnd() - 0.5) * 70
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(pos, 3))
    const mat = new PointsMaterial({
      size: 0.03,
      color: new Color('#d6d3cc'),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    const p = new Points(geo, mat)
    p.renderOrder = RENDER_ORDER.DUST
    p.layers.set(LAYER.DUST)
    p.frustumCulled = false
    return p
  })
  useEffect(
    () => () => {
      points.geometry.dispose()
      ;(points.material as PointsMaterial).dispose()
    },
    [points],
  )
  useFrame((_, dt) => {
    points.rotation.y += 0.02 * dt
  })
  return <primitive object={points} />
}

function Post({ depthView }: { depthView: boolean }) {
  const [depth] = useState(() => new LinearDepthEffect(40))
  useEffect(() => () => depth.dispose(), [depth])
  if (depthView)
    return (
      <EffectComposer multisampling={0} frameBufferType={HalfFloatType} renderPriority={1}>
        <primitive object={depth} />
      </EffectComposer>
    )
  return (
    <EffectComposer multisampling={0} frameBufferType={HalfFloatType} renderPriority={1}>
      <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.1} intensity={1.1} />
      <ToneMapping mode={ToneMappingMode.AGX} />
    </EffectComposer>
  )
}

/** Scripted path (window.__s1) or OrbitControls. */
function CameraRig() {
  const path = useS1((s) => s.toggles.path)
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const pos = useRef(new Vector3())
  const target = useRef(new Vector3())
  useFrame(({ camera }) => {
    if (path === 'manual' || rt.pathStart < 0) return
    pathPose(path, (performance.now() - rt.pathStart) / 1000, pos.current, target.current)
    camera.position.copy(pos.current)
    camera.lookAt(target.current)
  }, PATH_PRIORITY)
  useEffect(() => {
    rt.controls = controls.current
    return () => {
      rt.controls = null
    }
  }, [])
  useEffect(() => {
    if (path === 'manual' && controls.current) {
      controls.current.target.copy(target.current.lengthSq() > 0 ? target.current : new Vector3(0, 2, -2))
      controls.current.update()
    }
  }, [path])
  return <OrbitControls ref={controls} makeDefault enabled={path === 'manual'} target={[0, 2, -2]} />
}

/**
 * Brackets every frame: BEGIN stamps the frame start; END renders the scene itself when no
 * composer is mounted (a positive priority turns off R3F's own render), then records the
 * frame's main-thread time, gl.info totals and Spark counters, and resets gl.info once.
 */
function FrameProbe({ post }: { post: boolean }) {
  const begin = useRef(0)
  const lastDisplay = useRef(-1)
  const gpu = useRef<GpuTimer | null>(null)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    gpu.current = makeGpuTimer(gl.getContext() as WebGL2RenderingContext)
    return () => {
      gpu.current = null
    }
  }, [gl])
  useFrame(() => {
    begin.current = performance.now()
    gpu.current?.begin()
  }, FRAME_BEGIN)
  useFrame(({ gl, scene, camera }) => {
    if (!post) gl.render(scene, camera)
    gpu.current?.end()
    const end = performance.now()
    let flags = 0
    if (rt.tweenActive) flags |= FLAG.TWEEN
    const probe = rt.probe
    if (probe) {
      if (probe.sortsSinceFrame > 0) flags |= FLAG.SORT_DONE
      if (probe.lodSinceFrame > 0) flags |= FLAG.LOD_TRAVERSE
      rt.draws.main += probe.drawsMain
      rt.draws.other += probe.drawsOther
      if (probe.drawsOther > 0) probe.leakFrames++
      probe.sortsSinceFrame = 0
      probe.lodSinceFrame = 0
      probe.drawsMain = 0
      probe.drawsOther = 0
    }
    if (rt.spark) {
      const c = sparkCounts(rt.spark)
      if (c.displayVersion !== lastDisplay.current) {
        flags |= FLAG.DISPLAY_SWAP
        lastDisplay.current = c.displayVersion
        rt.displaySwaps++
      }
      rt.splatSamples.frames++
      rt.splatSamples.active += c.active
      rt.splatSamples.generated += c.generated
    }
    const r = gl.info.render
    rt.info.frames++
    rt.info.calls += r.calls
    rt.info.triangles += r.triangles
    rt.info.points += r.points
    rt.info.lines += r.lines
    rt.lastInfo = { calls: r.calls, triangles: r.triangles, points: r.points }
    gl.info.reset()
    rt.ring.push(begin.current, end - begin.current, flags)
  }, FRAME_END)
  return null
}

interface GpuTimer {
  begin(): void
  end(): void
}

/** Whole-frame GPU time via EXT_disjoint_timer_query_webgl2 (Chrome has it; Safari not). */
function makeGpuTimer(ctx: WebGL2RenderingContext): GpuTimer | null {
  const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  if (!ext) return null
  const pending: WebGLQuery[] = []
  let active: WebGLQuery | null = null
  return {
    begin() {
      // Results arrive a few frames late; poll the oldest first, keep at most 8 in flight.
      while (pending.length > 0 && ctx.getQueryParameter(pending[0], ctx.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift()!
        if (ctx.getParameter(ext.GPU_DISJOINT_EXT)) rt.gpuDisjoint++
        else rt.gpu.push(ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6)
        ctx.deleteQuery(q)
      }
      if (pending.length >= 8) return
      active = ctx.createQuery()
      if (active) ctx.beginQuery(ext.TIME_ELAPSED_EXT, active)
    },
    end() {
      if (!active) return
      ctx.endQuery(ext.TIME_ELAPSED_EXT)
      pending.push(active)
      active = null
    },
  }
}

export function S1Scene() {
  const toggles = useS1((s) => s.toggles)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  useLayoutEffect(() => {
    enableMainCameraLayers(camera)
    rt.camera = camera
    rt.gl = gl
    rt.scene = scene
  }, [camera, gl, scene])

  useEffect(() => {
    // The composer forces NoToneMapping while mounted; direct rendering needs AgX back.
    if (!toggles.post) gl.toneMapping = AgXToneMapping
  }, [gl, toggles.post])

  return (
    <>
      <color attach="background" args={['#0b0b0c']} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} />
      <SparkWorld />
      <Floor reflector={toggles.reflector} />
      {toggles.points && <Dust />}
      <CameraRig />
      {toggles.post && <Post depthView={toggles.depthView} />}
      <FrameProbe post={toggles.post} />
    </>
  )
}
