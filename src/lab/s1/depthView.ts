import { Uniform } from 'three'
import { Effect, EffectAttribute } from 'postprocessing'

// Linear depth view of the composer's depth texture (white = near, black = maxDist and
// beyond). Checks the depth-proxy band: with proxies on, each diorama reads as a solid
// cube, while splats (depthWrite off) leave no trace.

const fragment = /* glsl */ `
uniform float maxDist;
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float viewZ = (cameraNear * cameraFar) / ((cameraFar - cameraNear) * depth - cameraFar);
  float d = clamp(-viewZ / maxDist, 0.0, 1.0);
  outputColor = vec4(vec3(1.0 - d), 1.0);
}
`

export class LinearDepthEffect extends Effect {
  constructor(maxDist = 40) {
    super('LinearDepthEffect', fragment, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([['maxDist', new Uniform(maxDist)]]),
    })
  }
}
