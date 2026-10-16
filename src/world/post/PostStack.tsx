import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { EffectComposer } from '@react-three/postprocessing'
import { HalfFloatType, Vector3 } from 'three'
import { useApp } from '../../app/store.ts'
import { readPose } from '../poses.ts'
import { createPostChain, disposePostChain, type PostChain } from './chain.ts'
import type { FogEffectOptions } from './FogEffect.ts'
import { claimFrameRender, FRAME_PRIORITY } from './frameOwner.ts'
import { dofActive, heightFogActive, readPostFocusOverride } from './postMode.ts'

// Mount once inside HyperspaceCanvas. Pass layout and ordering are documented in chain.ts.
//
// Depth: there is NO scene FogExp2 (Spark ignores it), so fog and DOF both read the
// composer's depth texture. Splats write no depth; the depth-only back-face proxies
// (RENDER_ORDER.DEPTH_PROXY band: colorWrite off, depthWrite on, drawn after every
// transparent band so they cull nothing) give each diorama cube a depth, so fog treats it
// as a solid volume and the DOF focuses on it rather than on the sky behind.
//
// Tone mapping: the AgX ToneMapping effect owns the curve. EffectComposer forces
// gl.toneMapping = NoToneMapping while mounted (the canvas keeps AgX only as a no-post
// fallback), and the last pass encodes to the sRGB drawing buffer.

export interface PostStackProps {
  enabled?: boolean
  /** Read once at mount; tune live through the ref (`chain.fog`). */
  fog?: FogEffectOptions
  /** Bloom intensity (default 1.1). */
  bloomIntensity?: number
  /** Luminance above which pixels bloom (default 1: only HDR emissive, toneMapped:false). */
  bloomThreshold?: number
  /** Film grain opacity (default 0.07). */
  grain?: number
  /** Bokeh scale (default 2.5). */
  bokehScale?: number
  /** Focus distance when nothing is selected or focused (world units, default 40). */
  fallbackFocus?: number
  /** The live effect chain (null until mounted), for sandboxes and the perf lab. */
  ref?: Ref<PostChain | null>
}

const FOCUS_RATE = 5
const HEIGHT_FOG_RATE = 3
/** Focus range grows with distance so a far orbit is not entirely out of focus. */
const FOCUS_RANGE_MIN = 6
const FOCUS_RANGE_PER_UNIT = 0.35

const focusRangeFor = (d: number) => Math.max(FOCUS_RANGE_MIN, d * FOCUS_RANGE_PER_UNIT)

export function PostStack({
  enabled = true,
  fog,
  bloomIntensity = 1.1,
  bloomThreshold = 1,
  grain = 0.07,
  bokehScale = 2.5,
  fallbackFocus = 40,
  ref,
}: PostStackProps) {
  const camera = useThree((s) => s.camera)
  const dofOn = useApp((s) => dofActive(s.mode, s.quality.dofOnlyFlyIn))
  const [chain, setChain] = useState<PostChain | null>(null)

  // Built in an effect (not useState/useMemo) so StrictMode's mount-unmount-mount disposes
  // a chain that is never used again instead of one that is still mounted. Rebuilt with the
  // camera because R3F's EffectComposer is recreated then, and postprocessing's
  // EffectComposer.dispose() disposes every pass still in its list, ours included.
  useEffect(() => {
    const c = createPostChain(camera, {
      fog,
      bloomIntensity,
      bloomThreshold,
      grain,
      bokehScale,
      focusDistance: fallbackFocus,
      focusRange: focusRangeFor(fallbackFocus),
    })
    const app = useApp.getState()
    c.fog.heightMix = heightFogActive(app.mode) ? 1 : 0
    c.passes.dof.enabled = dofActive(app.mode, app.quality.dofOnlyFlyIn)
    setChain(c)
    return () => {
      setChain(null)
      disposePostChain(c)
    }
    // Live props are applied below; only a camera swap rebuilds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  useEffect(() => {
    if (!chain) return
    chain.bloom.intensity = bloomIntensity
    chain.bloom.luminanceMaterial.threshold = bloomThreshold
    chain.grain.blendMode.opacity.value = grain
    chain.dof.bokehScale = bokehScale
  }, [chain, bloomIntensity, bloomThreshold, grain, bokehScale])

  useEffect(() => {
    if (chain) chain.passes.dof.enabled = dofOn
  }, [chain, dofOn])

  useEffect(() => {
    if (!enabled) return
    return claimFrameRender()
  }, [enabled])

  useImperativeHandle<PostChain | null, PostChain | null>(ref, () => chain, [chain])

  const [focus] = useState(() => ({
    point: new Vector3(),
    desired: new Vector3(),
    has: false,
    distance: fallbackFocus,
  }))

  useFrame((_, delta) => {
    if (!chain) return
    const app = useApp.getState()
    const dt = Math.min(delta, 0.1)

    const fogTarget = heightFogActive(app.mode) ? 1 : 0
    chain.fog.heightMix += (fogTarget - chain.fog.heightMix) * (1 - Math.exp(-HEIGHT_FOG_RATE * dt))

    if (!dofActive(app.mode, app.quality.dofOnlyFlyIn)) {
      focus.has = false
      return
    }
    const dof = chain.dof
    const id = app.mode === 'entering' || app.mode === 'exiting' ? app.focusedId : app.selectedId
    const found = readPostFocusOverride(focus.desired) || (id !== null && readPose(id, focus.desired))
    const k = 1 - Math.exp(-FOCUS_RATE * dt)
    if (found) {
      if (focus.has) focus.point.lerp(focus.desired, k)
      else focus.point.copy(focus.desired)
      focus.has = true
      // DOF.update() turns the target into a view-space focus distance each frame.
      dof.target = focus.point
      const e = camera.matrixWorld.elements
      const dx = focus.point.x - e[12]
      const dy = focus.point.y - e[13]
      const dz = focus.point.z - e[14]
      focus.distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    } else {
      focus.has = false
      dof.target = null
      focus.distance += (fallbackFocus - focus.distance) * k
      dof.cocMaterial.focusDistance = focus.distance
    }
    dof.cocMaterial.focusRange = focusRangeFor(focus.distance)
  }, FRAME_PRIORITY.POST_UNIFORMS)

  return (
    <EffectComposer
      enabled={enabled}
      multisampling={0}
      frameBufferType={HalfFloatType}
      depthBuffer
      stencilBuffer={false}
      mergeMode="none"
      renderPriority={FRAME_PRIORITY.COMPOSER}
    >
      {chain ? <PassPrimitives chain={chain} /> : null}
    </EffectComposer>
  )
}

/** The composer collects Pass instances among its direct children, in order. */
function PassPrimitives({ chain }: { chain: PostChain }) {
  return (
    <>
      {chain.list.map((p, i) => (
        <primitive key={i} object={p} dispose={null} />
      ))}
    </>
  )
}
