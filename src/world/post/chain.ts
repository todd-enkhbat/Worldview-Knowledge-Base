import {
  BlendFunction,
  BloomEffect,
  DepthOfFieldEffect,
  EffectPass,
  MaskFunction,
  NoiseEffect,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import type { Camera } from 'three'
import { FogEffect, type FogEffectOptions } from './FogEffect.ts'

// The post chain as four hand-built EffectPasses, in this order:
//
//   RenderPass  (EffectComposer) scene → HDR half-float target, linear, + depth texture
//   1 fog         depth-based exp² + analytic height fog
//   2 dof         its own pass so it blurs the *fogged* image; toggled via pass.enabled
//   3 bloomTone   threshold bloom on HDR emissive, added in linear light, then AgX
//   4 aaGrain     SMAA, then film grain
//
// Why hand-built passes rather than effect components + merging:
// - SMAA and DOF are convolution effects that re-sample the *pass input* (SMAA at edge
//   pixels, DOF for its blur), so any effect merged before them in the same pass is
//   silently dropped there. The composer's 'auto' merge only stops two convolutions from
//   sharing a pass; it would happily put fog before DOF, or AgX before SMAA.
// - EffectGroup would give the same structure but appends a full-screen CopyPass.
// - pass.enabled toggles DOF per camera mode without recompiling a shader.

export interface PostChainOptions {
  fog?: FogEffectOptions
  bloomIntensity: number
  bloomThreshold: number
  grain: number
  bokehScale: number
  focusDistance: number
  focusRange: number
}

export interface PostChain {
  fog: FogEffect
  dof: DepthOfFieldEffect
  bloom: BloomEffect
  toneMapping: ToneMappingEffect
  smaa: SMAAEffect
  grain: NoiseEffect
  passes: {
    fog: EffectPass
    dof: EffectPass
    bloomTone: EffectPass
    aaGrain: EffectPass
  }
  /** Passes in composer order. */
  list: readonly EffectPass[]
}

export function createPostChain(camera: Camera, o: PostChainOptions): PostChain {
  const fog = new FogEffect(camera, o.fog)

  const dof = new DepthOfFieldEffect(camera, {
    focusDistance: o.focusDistance,
    focusRange: o.focusRange,
    bokehScale: o.bokehScale,
    resolutionScale: 0.5,
  })
  // Same as the R3F wrapper: write CoC into alpha so the far/near composite blends cleanly.
  dof.maskFunction = MaskFunction.MULTIPLY_RGB_SET_ALPHA

  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD,
    luminanceThreshold: o.bloomThreshold,
    luminanceSmoothing: 0.12,
    mipmapBlur: true,
    intensity: o.bloomIntensity,
    radius: 0.72,
    levels: 7,
  })
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })

  const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM })
  // Premultiplied grain added on top: proportional to luminance, so the void stays black.
  const grain = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.ADD })
  grain.blendMode.opacity.value = o.grain

  const passes = {
    fog: new EffectPass(camera, fog),
    dof: new EffectPass(camera, dof),
    bloomTone: new EffectPass(camera, bloom, toneMapping),
    aaGrain: new EffectPass(camera, smaa, grain),
  }
  passes.dof.enabled = false

  return {
    fog,
    dof,
    bloom,
    toneMapping,
    smaa,
    grain,
    passes,
    list: [passes.fog, passes.dof, passes.bloomTone, passes.aaGrain],
  }
}

/** Frees every pass and its effects (EffectPass.dispose disposes its effects). */
export function disposePostChain(chain: PostChain): void {
  for (const p of chain.list) p.dispose()
}
