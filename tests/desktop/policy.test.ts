import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
const { cloudAiIsOff, sameWorkspace } = createRequire(import.meta.url)('../../electron/policy.cjs') as { cloudAiIsOff: (value: unknown) => boolean; sameWorkspace: (path: string, fingerprint: unknown) => boolean }
it('reuses only the same vault identity and refuses configured, selected, or unverified cloud providers', () => {
  const path = '/synthetic/my-vault', fingerprint = createHash('sha256').update(path).digest('hex')
  expect(sameWorkspace(path, fingerprint)).toBe(true); expect(sameWorkspace('/synthetic/another-vault', fingerprint)).toBe(false)
  expect(cloudAiIsOff({ provider: null, configured: false })).toBe(true)
  expect(cloudAiIsOff({ provider: 'openai', configured: true })).toBe(false)
  expect(cloudAiIsOff({ provider: 'anthropic', configured: false })).toBe(false)
  expect(cloudAiIsOff({ configured: false })).toBe(false); expect(cloudAiIsOff(null)).toBe(false)
})
