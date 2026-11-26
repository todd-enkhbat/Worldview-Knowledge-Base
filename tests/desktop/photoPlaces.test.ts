import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

const { registerPhotoPlaces } = createRequire(import.meta.url)('../../electron/photo-places.cjs')
function fixture() {
  const frame = { url: 'http://127.0.0.1:5173/#/maps' }, contents = { mainFrame: frame }
  const workspace = { path: '/one', origin: 'http://127.0.0.1:5173', contents }
  const event = { sender: contents, senderFrame: frame }
  const callbacks = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  const read = vi.fn(async (arg: number | string) => JSON.stringify(typeof arg === 'string' ? null : { records: [], nextOffset: arg === 0 ? 500 : null, total: 501, limited: true }))
  registerPhotoPlaces({ ipcMain: { handle: (name: string, callback: (event: unknown, input: unknown) => Promise<unknown>) => callbacks.set(name, callback) }, getWorkspace: () => workspace, readNative: read })
  const page = (input: unknown, client: unknown = event) => Promise.resolve().then(() => callbacks.get('worldview:photo-places')!(client, input))
  const thumb = (id: unknown) => callbacks.get('worldview:photo-thumbnail')!(event, id)
  return { read, workspace, event, page, thumb }
}
it('pages only after a local user starts a scan, preserves limited authorization and serializes concurrent requests', async () => {
  const f = fixture()
  expect(f.read).not.toHaveBeenCalled()
  await expect(f.page({ offset: 500 })).rejects.toThrow('Start')
  const one = await f.page({ requestAccess: false, includeLabels: true }) as { snapshotToken: string }
  await expect(f.page({ offset: 500, snapshotToken: 'other' })).rejects.toThrow('Start')
  const two = await f.page({ offset: 500, snapshotToken: one.snapshotToken })
  expect(f.read).toHaveBeenNthCalledWith(1, 0, false, true)
  expect(f.read).toHaveBeenNthCalledWith(2, 500, false, true)
  expect(one).toMatchObject({ nextOffset: 500, limited: true }); expect(two).toMatchObject({ nextOffset: null })
  await expect(f.page({ offset: 500 })).rejects.toThrow('Start')
  expect(f.read.mock.calls.map(([arg]) => arg)).toEqual([0, 500])
  expect(await f.thumb('photo/L0/001')).toBeNull()
})
it('rejects another frame or workspace and discards results if consent completes after a switch', async () => {
  const f = fixture()
  await expect(f.page({}, { ...f.event, senderFrame: { url: f.event.senderFrame.url } })).rejects.toThrow('local Worldview')
  f.read.mockImplementationOnce(async () => {
    f.workspace.path = '/two'
    return JSON.stringify({ records: [{ id: 'private' }], nextOffset: 500, total: 600, limited: false })
  })
  await expect(f.page({})).rejects.toThrow('workspace changed')
  await expect(f.page({ offset: 500 })).rejects.toThrow('Start')
  await expect(f.thumb('')).rejects.toThrow('Choose a photo')
  await expect(f.page({ offset: -1 })).rejects.toThrow('valid Photos')
})
it('propagates a revoked authorization and requires a fresh scan after a failed page', async () => {
  const f = fixture()
  const first = await f.page({}) as { snapshotToken: string }
  f.read.mockRejectedValueOnce(new Error('Photos access is off'))
  await expect(f.page({ offset: 500, snapshotToken: first.snapshotToken })).rejects.toThrow('Photos access is off')
  await expect(f.page({ offset: 500 })).rejects.toThrow('Start')
})
