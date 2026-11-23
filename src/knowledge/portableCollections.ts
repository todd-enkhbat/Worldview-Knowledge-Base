import { compareAndSwapWorldState, getStore, isRepoReady } from '../data/repo.ts'
import { COLLECTIONS_KV, refreshCollections, type CollectionsSnapshot, type SavedInvestigation } from '../workspace/collections.ts'
import type { KnowledgeSnapshot, ParsedSource } from './types.ts'
import { portableIdentity } from './portableIdentity.ts'

/** Build the exact collection merge before any portable source is written. An
 * existing UUID with different filters is reported; no collection is overwritten. */
export async function preparePortableCollections(parsed: readonly ParsedSource[], snapshot: KnowledgeSnapshot): Promise<(() => Promise<void>) | null> {
  const incoming = parsed[0]?.metadata?.portableInvestigations as SavedInvestigation[] | undefined
  if (!incoming?.length) return null
  const store = getStore()
  const raw = await store.getKv<CollectionsSnapshot>(COLLECTIONS_KV)
  if (raw && (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.collections))) throw new Error('The saved investigations format is unsupported. Nothing was overwritten.')
  const current: CollectionsSnapshot = structuredClone(raw ?? { schemaVersion: 1, revision: 0, collections: [] })
  const identities = new Map(parsed.flatMap((document) => { const identity = portableIdentity(document); return identity ? [[identity.sourceId, snapshot.sources.find((source) => source.externalId === document.externalId)?.id ?? identity.sourceId] as const] : [] }))
  let changed = false
  for (const collection of incoming) {
    const mapped = { ...collection, sourceIds: collection.sourceIds.map((id) => identities.get(id) ?? id) }
    const existing = current.collections.find((item) => item.id === mapped.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(mapped)) throw new Error(`The saved investigation “${mapped.title}” has a UUID collision or different filters. Nothing was overwritten.`)
    if (!existing) { current.collections.push(mapped); changed = true }
  }
  if (!changed) return null
  const expected = current.revision++
  return async () => {
    if (!isRepoReady() || getStore() !== store) throw new Error('The active workspace changed before investigations could be imported.')
    await compareAndSwapWorldState(COLLECTIONS_KV, current, expected)
    await refreshCollections()
  }
}
