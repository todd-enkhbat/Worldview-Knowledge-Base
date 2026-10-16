// The dust points material: a GLSL3 RawShaderMaterial whose vertex shader reads the
// integer state by gl_VertexID (texelFetch of X and D, Q.19 → world units, rendered at
// X + acc·D like the nodes), with additive soft sprites coloured by the owner's archetype.
// Brightness follows age: a flash as the burst condenses on the memory at its date, then
// a slow fade as the cloud diffuses. Unborn texels (ghosts) and free texels are culled.

import { AdditiveBlending, Color, GLSL3, RawShaderMaterial, type Texture } from 'three'
import { ARCHETYPES, type Archetype } from '../../domain/types.ts'
import { GLSL_PRECISION_HEADER } from '../../gpu/dust/glsl.ts'
import { STYLE_ARCHETYPE_MASK, STYLE_HIDDEN } from '../../gpu/dust/layout.ts'
import { UNIT } from '../../physics/fixed.ts'

/** Dust tint per archetype (the @theme tokens in src/index.css). */
const TINT: Record<Archetype, string> = {
  idea: '#9fd3e6', // glass
  entity: '#8d8a84', // concrete
  lens: '#c9973f', // brass
  document: '#d6d3cc', // bone
  memory: '#e8b04a', // ember
  demon: '#ff4a1c', // signal
}

export function dustPalette(): Float32Array {
  const out = new Float32Array(3 * ARCHETYPES.length)
  const c = new Color()
  ARCHETYPES.forEach((a, i) => {
    // Color.set converts the sRGB hex to the linear working space.
    c.set(TINT[a])
    out.set([c.r, c.g, c.b], 3 * i)
  })
  return out
}

export function dustPointsVertexShader(): string {
  return `${GLSL_PRECISION_HEADER}

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform isampler2D uX;
uniform isampler2D uD;
uniform isampler2D uAnchor;
uniform isampler2D uMeta;
uniform int uWidth;
uniform int uStep;
uniform float uAcc;
uniform float uStepsPerYear;
uniform float uSize;
uniform float uPixelScale;
uniform float uFade;
uniform vec3 uPalette[${ARCHETYPES.length}];

out vec3 vColor;
out float vAlpha;

const float INV_UNIT = ${(1 / UNIT).toExponential()};
const float INV_DRIFT = ${(1 / 256).toExponential()};

void main() {
  ivec2 p = ivec2(gl_VertexID % uWidth, gl_VertexID / uWidth);
  ivec4 an = texelFetch(uAnchor, p, 0);
  ivec4 meta = texelFetch(uMeta, p, 0);
  // Age in steps at the rendered time (step + acc); unborn (ghost), free and hidden texels are culled.
  bool unborn = an.w > uStep;
  float age = unborn ? -1.0 : float(uStep - an.w) + uAcc;
  if (age < 0.0 || (meta.y & ${STYLE_HIDDEN}) != 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }
  vec3 x = vec3(texelFetch(uX, p, 0).xyz);
  vec3 d = vec3(texelFetch(uD, p, 0).xyz);
  // Q.19 → u, with the clock's fractional step: X + acc·drift(D) (D is Q.27 per step).
  vec3 pos = (x + uAcc * d * INV_DRIFT) * INV_UNIT;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float years = age / uStepsPerYear;
  // Condense: a bright burst for its first ~2 s at the date; then diffuse and dim with years.
  float flash = 1.0 + 2.5 * exp(-age / 120.0);
  float glow = 0.22 + 0.78 * exp(-years / 4.0);
  float spread = 0.75 + 0.75 * (1.0 - exp(-years / 2.0));
  int arch = clamp(meta.y & ${STYLE_ARCHETYPE_MASK}, 0, ${ARCHETYPES.length - 1});
  vColor = uPalette[arch] * flash;
  vAlpha = glow * uFade;
  gl_PointSize = clamp(uSize * spread * uPixelScale / max(-mv.z, 0.05), 1.0, 48.0);
}
`
}

export function dustPointsFragmentShader(): string {
  return `${GLSL_PRECISION_HEADER}

in vec3 vColor;
in float vAlpha;
out vec4 fragColor;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  // Soft gaussian sprite, added (AdditiveBlending: src·α + dst).
  fragColor = vec4(vColor, exp(-4.0 * r2) * vAlpha);
}
`
}

export interface DustPointsTextures {
  readonly x: Texture
  readonly d: Texture
  readonly anchor: Texture
  readonly meta: Texture
}

export function createDustPointsMaterial(tex: DustPointsTextures, width: number, stepsPerYear: number): RawShaderMaterial {
  return new RawShaderMaterial({
    name: 'DustPoints',
    glslVersion: GLSL3,
    vertexShader: dustPointsVertexShader(),
    fragmentShader: dustPointsFragmentShader(),
    uniforms: {
      uX: { value: tex.x },
      uD: { value: tex.d },
      uAnchor: { value: tex.anchor },
      uMeta: { value: tex.meta },
      uWidth: { value: width },
      uStep: { value: 0 },
      uAcc: { value: 0 },
      uStepsPerYear: { value: stepsPerYear },
      uSize: { value: 0.16 },
      uPixelScale: { value: 1 },
      uFade: { value: 0 },
      uPalette: { value: dustPalette() },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  })
}
