import { create } from 'zustand'
import type { WorldStore } from '../data/WorldStore.ts'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { isShortMapLink } from './coordinates.ts'
import { nativePhotoId, nativePhotoPlace, parseMapLink, parsePlaceFile } from './imports.ts'
import { decodePlaces, emptyPlaces, PLACES_KEY, placeEntrySchema, type NativePhotoRecord, type PlaceEntry, type PlaceImportOptions, type PlaceImportReport, type PlacesSnapshot } from './types.ts'

export { nativePhotoId } from './imports.ts'
export type { NativePhotoRecord, PlaceEntry, PlaceProvider, PlaceImportOptions, PlaceImportReport } from './types.ts'
export const usePlaces = create<PlacesSnapshot & { loaded: boolean; busy: boolean; error: string | null }>(() => ({
  ...emptyPlaces(), loaded: false, busy: false, error: null,
}))

let bound: WorldStore | null = null, epoch = 0, queue: Promise<unknown> = Promise.resolve()
const dispose: (() => void)[] = []
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const workspace = () => ({ store: getStore(), generation: getWorldGeneration(), epoch })
const current = (scope: ReturnType<typeof workspace>) => isRepoReady() && bound === scope.store && getStore() === scope.store && getWorldGeneration() === scope.generation && scope.epoch === epoch
const publish = (value: PlacesSnapshot) => usePlaces.setState({ ...value, loaded: true, error: null })
export function resetPlaces() {
  for (const stop of dispose.splice(0)) stop()
  epoch++; bound = null; queue = Promise.resolve()
  usePlaces.setState({ ...emptyPlaces(), loaded: false, busy: false, error: null })
}
async function refresh() {
  const scope = workspace()
  try {
    const value = decodePlaces(await scope.store.getKv(PLACES_KEY))
    if (current(scope) && value.revision >= usePlaces.getState().revision) publish(value)
  } catch (error) {
    if (current(scope)) usePlaces.setState({ error: message(error) })
    throw error
  }
}
export async function initializePlaces() {
  if (!isRepoReady()) return
  const store = getStore()
  if (bound !== store) {
    resetPlaces(); bound = store
    dispose.push(subscribeRepo(change => {
      if (!isRepoReady() || getStore() !== store || bound !== store) return
      const replaced = change.type === 'wipe' || change.type === 'import'
      if (replaced) { epoch++; queue = Promise.resolve(); usePlaces.setState({ ...emptyPlaces(), loaded: false, busy: false, error: null }) }
      if (replaced || change.type === 'kv' && change.keys.includes(PLACES_KEY)) void refresh().catch(() => {})
    }))
    dispose.push(useRepoStatus.subscribe(status => { if (!status.ready && bound === store) resetPlaces() }))
  }
  return refresh()
}
interface Incoming { entries: PlaceEntry[]; skipped?: number; issues?: string[]; replacePhotoAccount?: string; resolvedAlias?: string }
function update(prepare: () => Incoming | Promise<Incoming>): Promise<PlaceImportReport & { removed: number }> {
  if (!isRepoReady()) return Promise.reject(new Error('Open your Worldview workspace to import places.'))
  const initialization = initializePlaces(), scope = workspace()
  void initialization.catch(() => {})
  const assertCurrent = () => { if (!current(scope)) throw new Error('Your workspace changed during import. Reopen Maps before trying again.') }
  const task = queue.catch(() => {}).then(async () => {
    await initialization
    assertCurrent()
    if (!useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport) throw new Error('Open the editing workspace and finish any backup recovery before importing places.')
    usePlaces.setState({ busy: true, error: null })
    try {
      const incoming = await prepare()
      assertCurrent()
      const snapshot = decodePlaces(await scope.store.getKv(PLACES_KEY))
      const entries = new Map(snapshot.entries.map(e => [e.id, e]))
      const report = { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: incoming.skipped ?? 0, issues: incoming.issues ?? [] }
      const incomingIds = new Set<string>()
      for (const item of incoming.entries) {
        incomingIds.add(item.id)
        const old = entries.get(item.id)
        if (!old) { entries.set(item.id, item); report.added++; continue }
        const next = { ...item, importedAt: old.importedAt }
        if (old.kind === 'saved') {
          // A second list with the same place URL often has no coordinates or address.
          next.sourceFile = old.sourceFile
          next.latitude ??= old.latitude; next.longitude ??= old.longitude
          next.address ||= old.address; next.startedAt ??= old.startedAt
          if (old.lists || item.lists) {
            const memberships = new Map((old.lists || []).map(list => [list.name, list]))
            for (const list of item.lists || []) memberships.set(list.name, list)
            next.lists = [...memberships.values()].sort((a,b) => a.name.localeCompare(b.name))
            next.detail = next.lists.map(list => list.detail).filter(Boolean).join(' · ').slice(0, 4000)
          }
        }
        if (nativePhotoId(item) && !item.visualLabels && old.visualLabels) next.visualLabels = old.visualLabels
        const canonical = placeEntrySchema.parse(next)
        if (JSON.stringify(old) === JSON.stringify(canonical)) { report.unchanged++; continue }
        entries.set(item.id, canonical); report.updated++
      }
      if (incoming.resolvedAlias && !incomingIds.has(incoming.resolvedAlias) && entries.delete(incoming.resolvedAlias)) report.removed++
      if (incoming.replacePhotoAccount !== undefined) {
        for (const entry of snapshot.entries) {
          if (entry.account.toLowerCase() !== incoming.replacePhotoAccount.toLowerCase() || !nativePhotoId(entry) || incomingIds.has(entry.id)) continue
          entries.delete(entry.id); report.removed++
        }
      }
      assertCurrent()
      if (report.added || report.updated || report.removed) {
        const next = decodePlaces({ ...snapshot, revision: snapshot.revision + 1, entries: [...entries.values()] })
        await compareAndSwapWorldState(PLACES_KEY, next, snapshot.revision)
        assertCurrent(); publish(next)
      }
      return report
    } catch (error) {
      if (current(scope)) { await refresh().catch(() => {}); usePlaces.setState({ error: message(error) }) }
      throw error
    } finally { if (current(scope)) usePlaces.setState({ busy: false }) }
  })
  queue = task; return task
}
export function importPlaceEntries(entries: PlaceEntry[]) { return update(() => ({ entries })) }
export function importMapLink(value: string, options: PlaceImportOptions = {}) {
  return update(async () => {
    const original = parseMapLink(value, options)
    if (!isShortMapLink(original.url)) return { entries: [original] }
    try {
      const response = await fetch('/api/map-link', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'worldview-maps' }, body: JSON.stringify({ url: original.url }), signal: AbortSignal.timeout(7000) })
      if (response.ok) {
        const body = await response.json() as { url?: string }
        if (body.url) return { entries: [parseMapLink(body.url, options)], resolvedAlias: original.id }
      }
    } catch { /* An offline save still retains the user's link for a later retry. */ }
    return { entries: [original] }
  })
}
function readPlaceFile(file: File, options: PlaceImportOptions): ReturnType<typeof parsePlaceFile> {
  if (file.size < 512 * 1024 || typeof Worker === 'undefined') return parsePlaceFile(file, options)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module', name: 'map-import' })
    worker.onmessage = ({ data }: MessageEvent<{ result: Awaited<ReturnType<typeof parsePlaceFile>> } | { error: string }>) => {
      worker.terminate()
      if ('error' in data) reject(new Error(data.error)); else resolve(data.result)
    }
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || 'The place file could not be read.')) }
    try { worker.postMessage({ file, options }) } catch (error) { worker.terminate(); reject(error) }
  })
}
export function importPlaceFiles(files: File[], options: PlaceImportOptions = {}) {
  return update(async () => {
    const result = { entries: [] as PlaceEntry[], skipped: 0, issues: [] as string[] }
    for (const file of files) {
      try {
        const parsed = await readPlaceFile(file, options)
        for (const entry of parsed.entries) result.entries.push(entry)
        result.skipped += parsed.skipped; result.issues.push(...parsed.issues)
      } catch (error) { result.skipped++; result.issues.push(file.name + ': ' + message(error)) }
    }
    return result
  })
}
function photoBatch(records: NativePhotoRecord[], account: string) {
  const entries = records.map(record => nativePhotoPlace(record, account)).filter((v): v is PlaceEntry => !!v)
  return { entries, skipped: records.length - entries.length }
}
export function importPhotoLibraryRecords(records: NativePhotoRecord[], account = '') {
  return update(() => photoBatch(records, account))
}
/** Use only after the native helper returned every authorized page successfully. */
export function replacePhotoLibraryRecords(records: NativePhotoRecord[], account = '') {
  return update(() => ({ ...photoBatch(records, account), replacePhotoAccount: account.trim().slice(0, 300) }))
}
