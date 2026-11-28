import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { WORKSPACE_SECTIONS } from '../../src/workspace/context.ts'
const { cloudAiIsOff, sameWorkspace, workspacePageFromUrl } = createRequire(import.meta.url)('../../electron/policy.cjs') as {
  cloudAiIsOff: (value: unknown) => boolean
  sameWorkspace: (path: string, fingerprint: unknown) => boolean
  workspacePageFromUrl: (url: string, origin: string) => string | null
}
it('reuses only the same vault identity and refuses configured, selected, or unverified cloud providers', () => {
  const path = '/synthetic/my-vault', fingerprint = createHash('sha256').update(path).digest('hex')
  expect(sameWorkspace(path, fingerprint)).toBe(true); expect(sameWorkspace('/synthetic/another-vault', fingerprint)).toBe(false)
  expect(cloudAiIsOff({ provider: null, configured: false })).toBe(true)
  expect(cloudAiIsOff({ provider: 'openai', configured: true })).toBe(false)
  expect(cloudAiIsOff({ provider: 'anthropic', configured: false })).toBe(false)
  expect(cloudAiIsOff({ configured: false })).toBe(false); expect(cloudAiIsOff(null)).toBe(false)
})

it('remembers workspace sections and Explore without record or form parameters', () => {
  const origin = 'http://127.0.0.1:5173'
  for (const section of [...WORKSPACE_SECTIONS, 'explore']) {
    expect(workspacePageFromUrl(`${origin}/#/${section}?new=1`, origin)).toBe(`#/${section}`)
  }
  expect(workspacePageFromUrl(origin + '/#/archive?source=saved', origin)).toBe('#/library')
  for (const url of [origin + '/#/lab', origin + '/#/bookshelf/missing', origin + '/#/unknown', origin + '/helper/#/bookshelf', 'https://example.com/#/bookshelf']) {
    expect(workspacePageFromUrl(url, origin)).toBeNull()
  }
})
