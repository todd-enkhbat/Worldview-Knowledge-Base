import { File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, useRepoStatus } from '../../src/data/repo.ts'
import { readWorldSnapshot } from '../../src/data/worldSnapshot.ts'
import { importPlaceFiles, importPhotoLibraryRecords, initializePlaces, replacePhotoLibraryRecords, resetPlaces, usePlaces } from '../../src/places/store.ts'

beforeEach(async () => { resetPlaces(); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializePlaces() })
afterEach(async () => { resetPlaces(); await closeRepo() })
const list = () => new NodeFile(['Title,Note,URL,Tags,Comment\nLibrary,Shelves,https://www.google.com/maps?q=42.5%2C-71.3,ideas,'], 'Saved.csv') as unknown as File
it('persists imported places and source accounts in backup with stable re-imports', async () => {
  const one = await importPlaceFiles([list()], { account: 'Personal' })
  expect(one.added).toBe(1)
  expect((await importPlaceFiles([list()], { account: 'Personal' })).unchanged).toBe(1)
  expect((await importPlaceFiles([list()], { account: 'Work' })).added).toBe(1)
  expect((await readWorldSnapshot(getStore())).kv['places.v1']).toMatchObject({ entries: [{ account: 'Personal' }, { account: 'Work' }] })
  resetPlaces(); await initializePlaces()
  expect(usePlaces.getState().entries).toHaveLength(2)
  useRepoStatus.setState({ writer: false })
  await expect(importPlaceFiles([list()])).rejects.toThrow(/editing workspace/)
})
it('reconciles only the completed native library and retains prior visual classification on metadata refresh', async () => {
  const a = { id: '1', title: 'Cliff', date: '2024-05-02T13:14:00Z', latitude: 45, longitude: -79, keywords: ['Trip'], visualLabels: ['cliff'] }
  const b = { ...a, id: '2', title: 'Lake' }
  await importPlaceFiles([list()])
  await importPhotoLibraryRecords([b], 'Work')
  await replacePhotoLibraryRecords([a,b], 'Home')
  const changed = await replacePhotoLibraryRecords([{ ...b, visualLabels: undefined, keywords: ['Holiday'], latitude: 46 }], 'Home')
  expect(changed).toMatchObject({ removed: 1, updated: 1 })
  expect(usePlaces.getState().entries).toHaveLength(3)
  expect(usePlaces.getState().entries.find(e=>e.account === 'Home')).toMatchObject({ latitude: 46, detail: 'Holiday', visualLabels: ['cliff'] })
})
it('preserves map coordinates and list-specific notes when the same place appears in multiple exports', async () => {
  const geo = new NodeFile([JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [-87.65,41.94] }, properties: { Title: 'Park', 'Google Maps URL': 'https://maps.google.com/?cid=12' } })], 'Saved Places.json') as unknown as File
  const csv = (name: string, note: string) => new NodeFile(['Title,URL,Note\nPark,https://maps.google.com/?cid=12,' + note], name + '.csv') as unknown as File
  await importPlaceFiles([geo, csv('Games','Baseball'), csv('Chicago','North side')])
  const [entry] = usePlaces.getState().entries
  expect(usePlaces.getState().entries).toHaveLength(1)
  expect(entry).toMatchObject({ latitude: 41.94, longitude: -87.65, lists: [{name:'Chicago',detail:'North side'}, {name:'Games',detail:'Baseball'}] })
  expect((await importPlaceFiles([csv('Games','Baseball')])).unchanged).toBe(1)
})
