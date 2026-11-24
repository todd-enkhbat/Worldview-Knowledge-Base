import { getBookshelfOriginalReferences, validateShelfBook } from '../bookshelf/model.ts'
import type { WorldSnapshot, WorldStore } from './WorldStore.ts'

/** Device handles, credentials and recovery markers never enter a portable snapshot. */
export const PORTABLE_WORLD_KEYS: readonly string[] = ['chat.v1', 'overlay.landauerPaid', 'ai.usage', 'knowledge.v1', 'knowledge.receipts.v1', 'workspace.v1', 'collections.v1', 'artifacts.v1', 'voiceInbox.v1', 'reading.v1', 'writing.v1', 'writingHistory.v1', 'bookshelves.v1', 'assistantEdits.v1']

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
  for (const id of writingOriginalReferences(snapshot.kv)) ids.add(id)
  for (const id of bookshelfOriginalReferences(snapshot.kv)) ids.add(id)
  return ids
}

/** Drafts, archived drafts and every retained published version own their original media. */
export function writingOriginalReferences(kv: Record<string, unknown>): Set<string> {
  const result = new Set<string>(), assetId = /^writing-[a-f0-9]{64}$/
  const add = (value: unknown) => { if (typeof value !== 'string' || !assetId.test(value)) throw new Error('Writing contains an invalid original media reference. The backup was not completed.'); result.add(value) }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  function content(value: unknown) {
    if (!object(value)) throw new Error('Writing contains incomplete rich text. The backup was not completed.')
    const queue: { value: Record<string, unknown>; depth: number }[] = [{ value, depth: 0 }]; let count = 0
    while (queue.length) {
      const current = queue.pop()!
      if (++count > 50000 || current.depth > 64) throw new Error('Writing rich text exceeds the supported backup structure.')
      if (current.value.type === 'writingMedia') add(object(current.value.attrs) ? current.value.attrs.assetId : undefined)
      if (current.value.content !== undefined) { if (!Array.isArray(current.value.content)) throw new Error('Writing contains an invalid media structure.'); for (const child of current.value.content) { if (!object(child)) throw new Error('Writing contains an invalid media structure.'); queue.push({ value: child, depth: current.depth + 1 }) } }
    }
  }
  function appearance(value: unknown) { if (object(value) && value.backgroundAssetId != null) add(value.backgroundAssetId) }
  const writing = kv['writing.v1']
  if (writing !== undefined) {
    if (!object(writing) || writing.schemaVersion !== 1 || !Array.isArray(writing.docs)) throw new Error('Writing uses an unsupported backup format. Its saved copy was preserved.')
    for (const doc of writing.docs) { if (!object(doc)) throw new Error('Writing contains an invalid document.'); content(doc.content); appearance(doc.appearance) }
  }
  const history = kv['writingHistory.v1']
  if (history !== undefined) {
    if (!object(history) || history.schemaVersion !== 1 || !Array.isArray(history.entries) || history.entries.length > 10000) throw new Error('Writing history uses an unsupported backup format.')
    for (const entry of history.entries) { if (!object(entry) || !object(entry.document)) throw new Error('Writing history contains an incomplete snapshot.'); content(entry.document.content); appearance(entry.document.appearance) }
  }
  const assistant = kv['assistantEdits.v1']
  if (assistant !== undefined) {
    if (!object(assistant) || assistant.schemaVersion !== 1 || !Array.isArray(assistant.entries) || assistant.entries.length > 10000) throw new Error('Assistant review history uses an unsupported backup format.')
    for (const entry of assistant.entries) {
      if (!object(entry)) throw new Error('Assistant review history contains an incomplete entry.')
      if (entry.document !== undefined) { if (!object(entry.document)) throw new Error('Assistant review history contains an incomplete draft.'); content(entry.document.content); appearance(entry.document.appearance) }
    }
  }
  const knowledge = kv['knowledge.v1'] as { versions?: { originalPurged?: boolean; metadata?: Record<string, unknown> }[] } | undefined
  for (const version of knowledge?.versions ?? []) {
    if (version.originalPurged || !version.metadata) continue
    const metadata = version.metadata
    if (metadata.writingAssetIds !== undefined) { if (!Array.isArray(metadata.writingAssetIds)) throw new Error('A published writing version has invalid original references.'); for (const id of metadata.writingAssetIds) add(id) }
    if (metadata.format === 'writing') { if (metadata.content !== undefined) content(metadata.content); appearance(metadata.appearance) }
  }
  return result
}

export function voiceOriginalReferences(kv: Record<string, unknown>): { id: string; bytes: number; hash: string }[] {
  const inbox = kv['voiceInbox.v1'] as { schemaVersion?: number; entries?: { blobId?: string; bytes?: number; hash?: string }[] } | undefined
  if (!inbox || inbox.schemaVersion !== 1) return []
  if (!Array.isArray(inbox.entries) || inbox.entries.some((entry) => !entry || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || entry.blobId !== `voice-${entry.hash}` || !Number.isSafeInteger(entry.bytes) || entry.bytes! < 0)) throw new Error('The voice inbox contains invalid original references.')
  return inbox.entries.map((entry) => ({ id: entry.blobId!, bytes: entry.bytes!, hash: entry.hash! }))
}

/** Assistant proposals also retain the exact cover shown during review. */
export function bookshelfOriginalReferences(kv: Record<string, unknown>): Set<string> {
  const ids = getBookshelfOriginalReferences(kv['bookshelves.v1'])
  const assistant = kv['assistantEdits.v1'] as { schemaVersion?: number; entries?: unknown[] } | undefined
  if (assistant !== undefined) {
    if (!assistant || assistant.schemaVersion !== 1 || !Array.isArray(assistant.entries) || assistant.entries.length > 10000) throw new Error('Assistant review history uses an unsupported backup format.')
    for (const entry of assistant.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Assistant review history contains an incomplete entry.')
      const book = (entry as { book?: unknown }).book
      if (book !== undefined) { const retained = validateShelfBook(book); if (retained.coverAssetId) ids.add(retained.coverAssetId) }
    }
  }
  return ids
}
