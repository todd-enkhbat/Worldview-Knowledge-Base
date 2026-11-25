// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CrmAvatar } from '../../src/crm/CrmControls.tsx'
import { closeRepo, getStore, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const revoke = vi.fn(), portraitId = `crm-avatar-${'a'.repeat(64)}`
beforeEach(async () => { await initRepo({ store: createMemoryStore() }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); const BaseURL = URL; vi.stubGlobal('URL', class extends BaseURL { static override createObjectURL() { return 'blob:portrait-a' } static override revokeObjectURL(value: string) { revoke(value) } }); revoke.mockClear() })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('never carries a previous contact portrait into a reused table row without a photo', async () => {
  await getStore().putBlob({ meta: { id: portraitId, kind: 'image', mime: 'image/png', bytes: 3, createdAt: 1, nodeId: null }, data: new Blob(['png'], { type: 'image/png' }) })
  await act(async () => root.render(<CrmAvatar name="Ada Example" assetId={portraitId} />))
  expect(host.querySelector('img')?.src).toBe('blob:portrait-a')
  await act(async () => root.render(<CrmAvatar name="Grace Example" assetId={null} />))
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toBe('GE'); expect(revoke).toHaveBeenCalledWith('blob:portrait-a')
})
it('discards a late portrait read after switching people', async () => {
  let release!: (blob: Blob) => void
  vi.spyOn(getStore(), 'getBlob').mockImplementation(() => new Promise(resolve => { release = resolve }))
  await act(async () => root.render(<CrmAvatar name="Ada Example" assetId={portraitId} />))
  await act(async () => root.render(<CrmAvatar name="Grace Example" assetId={null} />))
  await act(async () => release(new Blob(['png'], { type: 'image/png' })))
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toBe('GE')
})
