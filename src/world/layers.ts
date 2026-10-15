// Render layers and transparent-object ordering, shared by every scene module.
//
// drei's reflector camera is a fresh PerspectiveCamera that renders ONLY layer 0, so the
// floor reflects only the architecture and solid nodes. Everything transparent or
// view-dependent goes on a higher layer that is enabled on the main camera only.

export const LAYER = {
  /** Architecture + solid node meshes. Seen by the main camera AND the reflector. */
  SOLID: 0,
  /** Gaussian splats (Spark). */
  SPLATS: 1,
  /** GPU dust points and filaments. */
  DUST: 2,
  /** troika labels and HUD-in-world text. */
  LABELS: 3,
  /** Dark-glass and fresnel shells around dioramas; ghosts of unborn nodes. */
  GLASS: 4,
} as const

/** Enable every non-solid layer on the main camera (call once per camera). */
export function enableMainCameraLayers(camera: { layers: { enable(n: number): void } }): void {
  for (const l of Object.values(LAYER)) camera.layers.enable(l)
}

/** renderOrder bands for transparent objects (lower draws first). */
export const RENDER_ORDER = {
  DUST: -2, // dust, filaments
  BACK_SHELL: -1, // dark-glass back shells (depthWrite OFF)
  SPLATS: 0, // Spark
  FRONT_SHELL: 1, // additive fresnel front shells (carry onDoubleClick)
  LABELS: 2,
  /** Depth-only back-face proxies (colorWrite off, depthWrite on): post effects see cube
   *  depth without culling transparent content drawn earlier. */
  DEPTH_PROXY: 100,
} as const
