import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Canvas, useFrame, useThree, type CanvasProps, type RootState } from '@react-three/fiber'
import { AgXToneMapping, Color } from 'three'
import { useApp } from '../app/store.ts'
import { MAX_ANCHOR_RADIUS, MAX_SPAN_UNITS } from '../domain/constants.ts'
import { enableMainCameraLayers } from './layers.ts'
import { FRAME_PRIORITY, isFrameRenderClaimed } from './post/frameOwner.ts'
import { QualityManager } from './quality.ts'
import { recordFrame } from './renderStats.ts'

// The one WebGL2 canvas for the world (and for sandboxes / lab pages that want the same
// renderer setup).
//
// - antialias off: SMAA in the post stack does AA; MSAA on a half-float composer target
//   would cost more than it buys and Spark splats do not benefit from it.
// - Rendering is scene-linear HDR. The post stack's AgX ToneMapping effect owns the curve
//   (EffectComposer forces gl.toneMapping = NoToneMapping while mounted); AgX on the
//   renderer is only the fallback for a canvas mounted without post.
// - gl.info.autoReset = false: the composer, Spark, the reflector and every post pass all
//   render each frame, and an auto-reset would leave only the last pass in the counters.
//   FrameStats reads the totals at the very end of the frame and resets exactly once.

export const CAMERA_NEAR = 0.1
/**
 * The world column spans up to MAX_SPAN_UNITS (3000 u) in Y with anchors out to
 * MAX_ANCHOR_RADIUS; a camera framing the whole column from outside must still see its
 * far side, so far = 2 × the column's bounding diagonal (≈ 13.4k u). A sky dome or star
 * shell must sit inside this. Depth precision at near 0.1 stays under ~1 u at 1000 u,
 * ample for fog and DOF.
 */
export const CAMERA_FAR = Math.ceil(2 * Math.hypot(MAX_SPAN_UNITS, 2 * MAX_ANCHOR_RADIUS))
/** Void black, sRGB (matches --color-void). */
export const VOID_COLOR = '#0b0b0c'

export interface HyperspaceCanvasProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** Mount the adaptive QualityManager (default true). */
  adaptiveQuality?: boolean
  /** Initial default-camera settings; near/far default to CAMERA_NEAR/CAMERA_FAR. */
  camera?: { fov?: number; position?: [number, number, number]; near?: number; far?: number }
  frameloop?: CanvasProps['frameloop']
  onCreated?: (state: RootState) => void
}

export function HyperspaceCanvas({
  children,
  className,
  style,
  adaptiveQuality = true,
  camera,
  frameloop,
  onCreated,
}: HyperspaceCanvasProps) {
  const maxDpr = useApp((s) => s.quality.dpr)
  // Frozen: camera options only matter at creation, and a fresh object per render is noise.
  const [cameraProps] = useState(() => ({
    fov: camera?.fov ?? 50,
    near: camera?.near ?? CAMERA_NEAR,
    far: camera?.far ?? CAMERA_FAR,
    position: camera?.position ?? ([70, 40, 70] as [number, number, number]),
  }))

  return (
    <Canvas
      className={className}
      style={style}
      frameloop={frameloop}
      dpr={[1, maxDpr]}
      gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, depth: true }}
      camera={cameraProps}
      onCreated={(state) => {
        const { gl } = state
        gl.info.autoReset = false
        gl.toneMapping = AgXToneMapping
        gl.setClearColor(new Color(VOID_COLOR), 1)
        // Dev-only QA handle (like window.__wv): scene, camera and gl for console inspection.
        if (import.meta.env.DEV) Object.assign(globalThis, { __r3f: state })
        onCreated?.(state)
      }}
    >
      <MainCameraLayers />
      <FrameStats />
      {adaptiveQuality && <QualityManager />}
      {children}
    </Canvas>
  )
}

/** Every camera that becomes the default (including makeDefault rigs) sees all layers. */
function MainCameraLayers() {
  const camera = useThree((s) => s.camera)
  useLayoutEffect(() => {
    enableMainCameraLayers(camera)
  }, [camera])
  return null
}

/**
 * Brackets the frame: STATS_BEGIN stamps the CPU start before any other callback,
 * STATS_END runs after the composer (or renders the scene itself when no composer has
 * claimed the frame, since a positive priority disables R3F's own render), then reads
 * gl.info for the whole frame and resets it.
 */
function FrameStats() {
  const begin = useRef(0)
  useFrame(() => {
    begin.current = performance.now()
  }, FRAME_PRIORITY.STATS_BEGIN)
  useFrame(({ gl, scene, camera }) => {
    if (!isFrameRenderClaimed()) gl.render(scene, camera)
    const now = performance.now()
    recordFrame(gl.info, now, now - begin.current)
    gl.info.reset()
  }, FRAME_PRIORITY.STATS_END)
  return null
}
