import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, handleRemoteChange, initRepo, useRepoStatus } from '../../src/data/repo.ts'
const mocks = vi.hoisted(() => ({ notify: vi.fn(), cancel: vi.fn() }))
vi.mock('../../src/data/autoBackup.ts', () => ({ createAutoBackup: () => ({ notifyChange: mocks.notify, cancel: mocks.cancel }) }))
afterEach(async () => { await closeRepo(); mocks.notify.mockReset(); mocks.cancel.mockReset() })
it('schedules remote service CRM edits for backup only in the writer window', async () => {
  const memory = createMemoryStore(), store = { ...memory, info: { kind: 'sqlite' as const, blobBackend: 'server' as const } }
  await initRepo({ store, autoBackup: true }); expect(useRepoStatus.getState().writer).toBe(true)
  await handleRemoteChange({ type: 'kv', keys: ['crm.v1'] }); expect(mocks.notify).toHaveBeenCalledTimes(1)
  await handleRemoteChange({ type: 'kv', keys: ['chat.v1'] }); expect(mocks.notify).toHaveBeenCalledTimes(1)
  useRepoStatus.setState({ writer: false }); await handleRemoteChange({ type: 'kv', keys: ['crm.v1'] }); expect(mocks.notify).toHaveBeenCalledTimes(1)
})
