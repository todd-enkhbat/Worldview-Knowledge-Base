// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { PhotoSource } from '../../src/places/PhotoSource.tsx'
import { readCalendarPlaces } from '../../src/places/calendar.ts'
import { initializePlaces, replacePhotoLibraryRecords, resetPlaces, usePlaces } from '../../src/places/store.ts'

type Read = NonNullable<NonNullable<Window['worldviewDesktop']>['readPhotoPlaces']>
const record = (id: string) => ({ id, title: id + '.jpg', latitude: 42, longitude: -71, keywords: ['Favorite walks'] })
const page = (records: ReturnType<typeof record>[], nextOffset: number | null, limited = false) => ({ records, nextOffset, limited, total: 2, snapshotToken: 'selected-snapshot' })
let root: Root, host: HTMLElement
const read = vi.fn<Read>()
beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetPlaces(); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializePlaces()
  read.mockReset()
  Object.defineProperty(window, 'worldviewDesktop', { configurable: true, value: { readPhotoPlaces: read } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  delete window.worldviewDesktop; resetPlaces(); await closeRepo()
})
const render = (preferences?: { automatic: boolean; lastRead: number }) => act(async () => root.render(<PhotoSource preferences={preferences}/>))

it('starts from an explicit click, passes the cursor and label choice, then replaces only the completed library', async () => {
  await replacePhotoLibraryRecords([record('old')], 'Apple Photos on this Mac')
  await replacePhotoLibraryRecords([record('other')], 'Imported account')
  let finish!: (result: Awaited<ReturnType<Read>>) => void
  read.mockResolvedValueOnce(page([record('new')], 1)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render()
  expect(read).not.toHaveBeenCalled()
  await act(async () => host.querySelector<HTMLInputElement>('[type=checkbox]')!.click())
  await act(async () => host.querySelector('button')!.click())
  expect(read.mock.calls.map(([input]) => input)).toEqual([
    { offset: 0, requestAccess: true, includeLabels: true, snapshotToken: undefined },
    { offset: 1, requestAccess: false, includeLabels: true, snapshotToken: 'selected-snapshot' },
  ])
  expect(usePlaces.getState().entries.map(r => r.title)).toEqual(['old.jpg', 'other.jpg'])
  await act(async () => finish(page([], null, true)))
  expect(usePlaces.getState().entries.map(r => r.title).sort()).toEqual(['new.jpg', 'other.jpg'])
  expect(host.querySelector('[role=status]')?.textContent).toContain('Limited Photos access')
  expect((await readCalendarPlaces()).photos?.automatic).toBe(true)
})
it('auto-refreshes a previously connected library without prompting and keeps confirmed entries after a revoked permission', async () => {
  await replacePhotoLibraryRecords([record('old')], 'Apple Photos on this Mac')
  read.mockRejectedValueOnce(new Error('Photos access is off.'))
  await render({ automatic: true, lastRead: 1 })
  expect(read).toHaveBeenCalledExactlyOnceWith({ offset: 0, requestAccess: false, includeLabels: false, snapshotToken: undefined })
  expect(host.querySelector('[role=status]')?.textContent).toBe('Photos access is off.')
  expect(usePlaces.getState().entries.map(r => r.title)).toEqual(['old.jpg'])
})
it('keeps automatic refresh turned off after a manual refresh', async () => {
  read.mockResolvedValueOnce(page([], null))
  await render({ automatic: false, lastRead: 1 })
  expect(read).not.toHaveBeenCalled()
  await act(async () => host.querySelector('button')!.click())
  expect((await readCalendarPlaces()).photos?.automatic).toBe(false)
})
