import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  EdgesGeometry,
  FrontSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
} from 'three'
import { LAYER, RENDER_ORDER } from '../../world/layers.ts'

// The glass terrarium around one diorama, following the PLAN's renderOrder bands:
//   back shell  (−1, BackSide, dark glass, depthWrite off, LAYER.GLASS)
//   splats       (0, Spark)
//   front shell  (1, FrontSide additive fresnel, depthWrite off, LAYER.GLASS)
//   depth proxy (100, BackSide, colorWrite off, depthWrite on, LAYER.GLASS)
// plus an emissive brass frame and a plinth on LAYER.SOLID, which the floor reflects.
//
// The depth proxy must be `transparent: true`: three draws the whole opaque list before
// the transparent list whatever the renderOrder, so an opaque depth-only box would land
// before the splats and cull everything behind its back faces.

export const BOX_HALF = 2

const boxGeo = new BoxGeometry(2 * BOX_HALF, 2 * BOX_HALF, 2 * BOX_HALF)
const edgeGeo = new EdgesGeometry(boxGeo)
const plinthGeo = new BoxGeometry(2 * BOX_HALF + 0.3, 0.2, 2 * BOX_HALF + 0.3)

const backMat = new MeshBasicMaterial({ color: new Color('#0b0b0c'), transparent: true, opacity: 0.45, side: BackSide, depthWrite: false })

const frontMat = new ShaderMaterial({
  uniforms: { tint: { value: new Color('#9fb4c8') }, strength: { value: 0.3 } },
  vertexShader: /* glsl */ `
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 tint;
    uniform float strength;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
      gl_FragColor = vec4(tint * f * strength, 1.0);
    }`,
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  side: FrontSide,
})

const depthMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, side: BackSide })

// HDR brass (> 1 in linear) so threshold bloom picks the frame up; toneMapped off.
const frameMat = new LineBasicMaterial({ color: new Color('#c9973f').multiplyScalar(3), toneMapped: false })
const plinthMat = new MeshStandardMaterial({ color: new Color('#3a3936'), roughness: 0.85, metalness: 0.1 })

export interface GlassBox {
  group: Group
  depthProxy: Mesh
  setDepthProxy(on: boolean, early: boolean): void
}

export function makeGlassBox(): GlassBox {
  const group = new Group()
  const back = new Mesh(boxGeo, backMat)
  back.renderOrder = RENDER_ORDER.BACK_SHELL
  back.layers.set(LAYER.GLASS)
  const front = new Mesh(boxGeo, frontMat)
  front.renderOrder = RENDER_ORDER.FRONT_SHELL
  front.layers.set(LAYER.GLASS)
  const depthProxy = new Mesh(boxGeo, depthMat)
  depthProxy.renderOrder = RENDER_ORDER.DEPTH_PROXY
  depthProxy.layers.set(LAYER.GLASS)
  const frame = new LineSegments(edgeGeo, frameMat)
  frame.layers.set(LAYER.SOLID)
  const plinth = new Mesh(plinthGeo, plinthMat)
  plinth.position.y = -BOX_HALF - 0.1
  plinth.layers.set(LAYER.SOLID)
  group.add(back, front, depthProxy, frame, plinth)
  return {
    group,
    depthProxy,
    setDepthProxy(on, early) {
      depthProxy.visible = on
      // −3 sits below the dust band: drawn before everything transparent.
      depthProxy.renderOrder = early ? -3 : RENDER_ORDER.DEPTH_PROXY
    },
  }
}
