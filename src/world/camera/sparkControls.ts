import { SparkControls } from '@sparkjsdev/spark'

// Exactly one SparkControls per canvas (PLAN § Rendering specifics → Camera).
// Spark attaches keyboard listeners to `document` and pointer/wheel listeners to the canvas
// in the constructor and never removes them, so a second instance (e.g. after a React
// remount) would double every input. The WeakMap keeps one per canvas for its lifetime.
// Other modules (the diorama interior) must get the controls from here, never construct them.

/** First-person flight speed (world units / s). Shift ×5, Ctrl ×0.2, CapsLock ×10 (Spark defaults). */
export const FP_MOVE_SPEED = 6

const byCanvas = new WeakMap<HTMLCanvasElement, SparkControls>()

export function sparkControlsFor(canvas: HTMLCanvasElement): SparkControls {
  let c = byCanvas.get(canvas)
  if (!c) {
    c = new SparkControls({ canvas })
    c.fpsMovement.moveSpeed = FP_MOVE_SPEED
    setSparkControlsEnabled(c, false)
    byCanvas.set(canvas, c)
  }
  return c
}

/**
 * Forget input that accumulated while the controls were idle: Spark keeps recording keys and
 * pointer drags/wheel even when disabled, and its update() measures dt from `lastTime`, so
 * without this the first frame jumps by the whole idle gap and any key held at the switch.
 */
export function resetSparkControls(c: SparkControls): void {
  c.lastTime = 0
  const fps = c.fpsMovement
  fps.keydown = {}
  fps.keycode = {}
  fps.extraMove.set(0, 0, 0)
  const p = c.pointerControls
  p.rotating = null
  p.sliding = null
  p.lastDown = null
  p.dualPress = false
  p.pressHeld = undefined
  p.doublePressed = undefined
  p.triplePressed = false
  p.scroll.set(0, 0, 0)
  p.rotateVelocity.set(0, 0, 0)
  p.moveVelocity.set(0, 0, 0)
}

export function setSparkControlsEnabled(c: SparkControls, on: boolean): void {
  c.fpsMovement.enable = on
  c.pointerControls.enable = on
}
