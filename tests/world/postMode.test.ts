import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import type { CameraMode } from '../../src/app/store.ts'
import { dofActive, heightFogActive, readPostFocusOverride, setPostFocus } from '../../src/world/post/postMode.ts'

const MODES: CameraMode[] = ['orbit', 'third_person', 'first_person', 'entering', 'interior', 'exiting', 'autonav', 'framing']

describe('post mode policy', () => {
  it('runs DOF only outside the diorama and first-person modes at full quality', () => {
    expect(MODES.filter((m) => dofActive(m, false))).toEqual(['orbit', 'third_person', 'exiting', 'autonav', 'framing'])
  })

  it('turns DOF off everywhere on the dofOnlyFlyIn rung (the fly-in is DOF-free already)', () => {
    for (const m of MODES) expect(dofActive(m, true)).toBe(false)
  })

  it('keeps height fog out of the diorama and first-person modes', () => {
    expect(MODES.filter(heightFogActive)).toEqual(['orbit', 'third_person', 'exiting', 'autonav', 'framing'])
  })

  it('holds and releases a focus override', () => {
    const out = new Vector3()
    setPostFocus({ x: 1, y: 2, z: 3 })
    expect(readPostFocusOverride(out)).toBe(true)
    expect(out.toArray()).toEqual([1, 2, 3])
    setPostFocus(null)
    expect(readPostFocusOverride(out)).toBe(false)
  })
})
