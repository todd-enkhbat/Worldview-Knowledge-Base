import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { titleFromFileName } from '../../src/world/splats/ingest/ingest.ts'
import { ENTRY_RADII, Y_DOWN_FIX, boxCentre, boxRadius, defaultEntryPose, poseInDisplayFrame } from '../../src/world/splats/ingest/pose.ts'
import { centreBoxes, readSpzHeader } from '../../src/world/splats/ingest/spzRead.ts'
import { transcodeToInterior } from '../../src/world/splats/ingest/transcode.ts'

const LION = join(import.meta.dirname, '../../public/fixtures/lion.v3.spz')

describe('transcodeToInterior (in-thread, Spark WASM in node)', () => {
  it.skipIf(!existsSync(LION))('lion.v3.spz → SPZ v3 interior, bounds, and a framed copy clipped to the 1–99 % box', async () => {
    const stages: string[] = []
    const r = await transcodeToInterior({ bytes: new Uint8Array(readFileSync(LION)), name: 'lion.v3.spz' }, (s) => stages.push(s))
    expect(stages).toEqual(['transcode', 'analyse', 'clip'])
    expect(r.format).toBe('spz')
    expect(r.stats.count).toBe(195_099)
    expect(await readSpzHeader(r.interior)).toMatchObject({ version: 3, numPoints: 195_099 })
    expect(r.framed).not.toBeNull()
    expect(r.framedCount).toBeLessThan(r.stats.count)
    expect(r.framedCount).toBeGreaterThan(0.9 * r.stats.count)
    expect((await readSpzHeader(r.framed!)).numPoints).toBe(r.framedCount)
    for (let i = 0; i < 3; i++) {
      expect(r.frame.min[i]).toBeGreaterThanOrEqual(r.stats.bounds.min[i])
      expect(r.frame.max[i]).toBeLessThanOrEqual(r.stats.bounds.max[i])
    }
  })

  it.skipIf(!existsSync(LION))('an explicit crop is baked into the interior and becomes the frame', async () => {
    const crop = { min: [-0.1, -0.3, -0.1] as [number, number, number], max: [0.1, 0, 0.1] as [number, number, number] }
    const r = await transcodeToInterior({ bytes: new Uint8Array(readFileSync(LION)), name: 'lion.v3.spz', crop })
    expect(r.framed).toBeNull()
    expect(r.frame).toEqual(crop)
    expect(r.stats.count).toBeLessThan(195_099)
    for (let i = 0; i < 3; i++) {
      expect(r.stats.bounds.min[i]).toBeGreaterThanOrEqual(crop.min[i] - 1e-3)
      expect(r.stats.bounds.max[i]).toBeLessThanOrEqual(crop.max[i] + 1e-3)
    }
  })

  it('refuses unrecognised bytes with the accepted extensions', async () => {
    await expect(transcodeToInterior({ bytes: new TextEncoder().encode('hello world'), name: 'notes.txt' })).rejects.toThrow(/\.spz, \.ply/)
  })
})

describe('framing helpers', () => {
  it('centreBoxes: exact bounds and a quantile box that ignores floaters', () => {
    const n = 1000
    const c = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) c.set([i / n, (i % 10) / 10, 0.5], 3 * i)
    c.set([50, -50, 9], 0) // one floater
    const { bounds, robust } = centreBoxes(c)
    expect(bounds.max[0]).toBe(50)
    expect(bounds.min[1]).toBe(-50)
    expect(robust.max[0]).toBeLessThan(1)
    expect(robust.min[1]).toBeGreaterThanOrEqual(0)
  })

  it('defaultEntryPose looks at the frame centre from 1.5 radii and is level after upFix', () => {
    const frame = { min: [-1, -2, -3], max: [3, 2, 1] }
    for (const upFix of [[0, 0, 0, 1], Y_DOWN_FIX] as [number, number, number, number][]) {
      const pose = defaultEntryPose(frame, upFix)
      const centre = boxCentre(frame)
      const eye = new Vector3(...pose.position)
      expect(eye.distanceTo(centre)).toBeCloseTo(ENTRY_RADII * boxRadius(frame), 4)
      const forward = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...pose.quaternion))
      expect(forward.dot(centre.clone().sub(eye).normalize())).toBeCloseTo(1, 5)
      // Seen through the up-fixed mesh, the camera's right vector is horizontal.
      const shown = poseInDisplayFrame(pose, upFix)
      expect(new Vector3(1, 0, 0).applyQuaternion(shown.quaternion).y).toBeCloseTo(0, 5)
      expect(new Vector3(0, 1, 0).applyQuaternion(shown.quaternion).y).toBeGreaterThan(0)
    }
  })

  it('titleFromFileName', () => {
    expect(titleFromFileName('lion.v3.spz')).toBe('Lion')
    expect(titleFromFileName('knock-community-hall.sog')).toBe('Knock community hall')
    expect(titleFromFileName('/fixtures/tomatoes.v4.spz?x=1')).toBe('Tomatoes')
    expect(titleFromFileName('')).toBe('Scene')
  })
})
