// Who renders the frame.
//
// HyperspaceCanvas runs its stats collector at a positive useFrame priority so it can read
// gl.info after *every* pass and reset it exactly once. Any positive priority switches off
// R3F's automatic gl.render, so the collector must render the scene itself whenever no
// composer has claimed the frame (e.g. a lab page that mounts the canvas without post).

let claims = 0

/** Called by a component that renders the frame itself (PostStack). Returns the release. */
export function claimFrameRender(): () => void {
  claims++
  let released = false
  return () => {
    if (released) return
    released = true
    claims--
  }
}

export function isFrameRenderClaimed(): boolean {
  return claims > 0
}

/** useFrame priorities shared by the canvas and the post stack (ascending = earlier). */
export const FRAME_PRIORITY = {
  /** Stamps the CPU frame start; must run before every other callback. */
  STATS_BEGIN: -10_000,
  /** Post focus / fog uniforms; before the composer renders. */
  POST_UNIFORMS: 0,
  /** EffectComposer.render. */
  COMPOSER: 1,
  /** Reads gl.info for the whole frame, then resets it. Always last. */
  STATS_END: 10_000,
} as const
