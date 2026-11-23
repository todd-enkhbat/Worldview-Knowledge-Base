import type { WorldSnapshot, WorldStore } from './WorldStore.ts'

/** Device handles, credentials and recovery markers never enter a portable snapshot. */
export const PORTABLE_WORLD_KEYS: readonly string[] = ['chat.v1', 'overlay.landauerPaid', 'ai.usage', 'knowledge.v1', 'knowledge.receipts.v1', 'workspace.v1', 'collections.v1', 'artifacts.v1', 'voiceInbox.v1']

export async function readWorldSnapshot(store: WorldStore, keys: readonly string[] = PORTABLE_WORLD_KEYS): Promise<WorldSnapshot> {
  if (keys.some((key) => !PORTABLE_WORLD_KEYS.includes(key))) throw new Error('Only portable world state can be included in a backup snapshot.')
  if (store.readWorldSnapshot) return store.readWorldSnapshot(keys)
  if (store.info.kind === 'sqlite') throw new Error('Consistent backups require the updated local app service. Restart the app server before exporting.')
  // Compatibility adapters have one repository writer. Production memory, IndexedDB
  // and HTTP stores provide the atomic implementation above.
  const [settings, nodes, events, assets, values] = await Promise.all([store.getSettings(), store.listNodes(), store.listEvents(), store.listAssets(), Promise.all(keys.map((key) => store.getKv(key)))])
  return { settings, nodes, events, assets, kv: Object.fromEntries(keys.flatMap((key, index) => values[index] === undefined ? [] : [[key, values[index]]])) }
}

export function referencedWorldAssets(snapshot: WorldSnapshot): Set<string> {
  const ids = new Set<string>()
  for (const node of snapshot.nodes) {
    for (const attachment of node.attachments) { ids.add(attachment.blobId); if (attachment.thumbBlobId) ids.add(attachment.thumbBlobId) }
    for (const id of [node.splat?.proxyAssetId, node.splat?.interiorAssetId, node.splat?.thumbAssetId]) if (id) ids.add(id)
  }
  const knowledge = snapshot.kv['knowledge.v1'] as { versions?: { originalBlobId?: string; originalPurged?: boolean }[]; imports?: { fileBlobIds?: string[] }[] } | undefined
  for (const version of knowledge?.versions ?? []) if (version.originalBlobId && !version.originalPurged) ids.add(version.originalBlobId)
  for (const receipt of knowledge?.imports ?? []) for (const id of receipt.fileBlobIds ?? []) if (id) ids.add(id)
  for (const voice of voiceOriginalReferences(snapshot.kv)) {
    const meta = snapshot.assets.find((asset) => asset.id === voice.id)
    if (meta && meta.bytes !== voice.bytes) throw new Error('A voice original does not match its retained receipt. The backup was not completed.')
    ids.add(voice.id)
  }
  return ids
}

export function voiceOriginalReferences(kv: Record<string, unknown>): { id: string; bytes: number; hash: string }[] {
  const inbox = kv['voiceInbox.v1'] as { schemaVersion?: number; entries?: { blobId?: string; bytes?: number; hash?: string }[] } | undefined
  if (!inbox || inbox.schemaVersion !== 1) return []
  if (!Array.isArray(inbox.entries) || inbox.entries.some((entry) => !entry || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || entry.blobId !== `voice-${entry.hash}` || !Number.isSafeInteger(entry.bytes) || entry.bytes! < 0)) throw new Error('The voice inbox contains invalid original references.')
  return inbox.entries.map((entry) => ({ id: entry.blobId!, bytes: entry.bytes!, hash: entry.hash! }))
}
