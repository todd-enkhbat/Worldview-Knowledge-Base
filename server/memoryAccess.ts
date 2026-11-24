import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { WorldDb } from './worldDb.ts'

const KEY = 'memory.clients.v1' // Device/service credentials deliberately excluded from exports.
export interface MemoryClient {
  id: string; name: string; worldId: string; tokenHash: string; sourceIds: string[] | null
  projectId: string | null; createdAt: number; expiresAt: number; revokedAt: number | null
  allowObservations: boolean
  /** Explicit local editing scopes; absent on existing read-only clients. */
  writingDocumentIds?: string[]
  allowCreateWriting?: boolean
  allowFiling?: boolean
  bookshelfBookIds?: string[]
  allowCreateBooks?: boolean
}
interface Registry { schemaVersion: 1; revision: number; clients: MemoryClient[] }
export type PublicMemoryClient = Omit<MemoryClient, 'tokenHash'>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const memoryTokenWorld = (token: string): string | null => /^wvm\.(local|[\da-f-]{36})\.[\w-]{43}$/.exec(token)?.[1] ?? null
const read = (db: WorldDb): Registry => db.getKv<Registry>(KEY) ?? { schemaVersion: 1, revision: 0, clients: [] }
const expose = ({ tokenHash: _tokenHash, ...client }: MemoryClient): PublicMemoryClient => client

export function listMemoryClients(db: WorldDb): PublicMemoryClient[] { return read(db).clients.map(expose) }
export function createMemoryClient(db: WorldDb, worldId: string, input: { name: string; sourceIds?: string[]; allSources?: boolean; projectId?: string; expiresInDays?: number; allowObservations?: boolean; writingDocumentIds?: string[]; allowCreateWriting?: boolean; allowFiling?: boolean; bookshelfBookIds?: string[]; allowCreateBooks?: boolean }, now = Date.now()): { client: PublicMemoryClient; token: string } {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Name this memory client.')
  if (input.expiresInDays !== undefined && (!Number.isFinite(input.expiresInDays) || input.expiresInDays < 1)) throw new Error('Choose a valid token lifetime.')
  if (input.allowObservations === true) throw new Error('Automatic observation capture is not enabled. Choose an explicit reviewed editing scope instead.')
  const editing = input.allowCreateWriting === true || input.allowFiling === true || !!input.writingDocumentIds?.length || input.allowCreateBooks === true || !!input.bookshelfBookIds?.length
  if (editing && worldId !== 'local') throw new Error('Reviewed assistant editing is available only in the local workspace.')
  if (input.writingDocumentIds !== undefined && (!Array.isArray(input.writingDocumentIds) || input.writingDocumentIds.length > 1000 || !input.writingDocumentIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1000))) throw new Error('Choose valid writing documents for this assistant.')
  if (input.bookshelfBookIds !== undefined && (!Array.isArray(input.bookshelfBookIds) || input.bookshelfBookIds.length > 1000 || !input.bookshelfBookIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1000))) throw new Error('Choose valid bookshelf records for this assistant.')
  if (input.allSources !== true && (!Array.isArray(input.sourceIds) || !input.sourceIds.length && !editing || input.sourceIds.length > 1000 || !input.sourceIds.every((id) => typeof id === 'string'))) throw new Error('Choose an explicit source scope for this client.')
  const snapshot = read(db)
  if (snapshot.clients.filter((client) => client.revokedAt === null && client.expiresAt > now).length >= 32) throw new Error('Revoke an unused client before adding another.')
  const token = `wvm.${worldId}.${randomBytes(32).toString('base64url')}`
  const client: MemoryClient = { id: randomUUID(), name: input.name.trim(), worldId, tokenHash: hash(token), sourceIds: input.allSources ? null : [...new Set(input.sourceIds)], projectId: typeof input.projectId === 'string' ? input.projectId.slice(0, 128) : null, createdAt: now, expiresAt: now + Math.max(1, Math.min(90, Math.floor(input.expiresInDays ?? 30))) * 86_400_000, revokedAt: null, allowObservations: false, ...(editing ? { writingDocumentIds: [...new Set(input.writingDocumentIds ?? [])], allowCreateWriting: input.allowCreateWriting === true, allowFiling: input.allowFiling === true, bookshelfBookIds: [...new Set(input.bookshelfBookIds ?? [])], allowCreateBooks: input.allowCreateBooks === true } : {}) }
  snapshot.clients.push(client); const revision = snapshot.revision++
  if (!db.compareAndSwapKv(KEY, snapshot, revision)) throw new Error('Memory clients changed. Refresh and retry.')
  return { client: expose(client), token }
}
export function revokeMemoryClient(db: WorldDb, id: string, now = Date.now()): void {
  const snapshot = read(db), client = snapshot.clients.find((client) => client.id === id)
  if (!client) throw new Error('Memory client not found.')
  client.revokedAt = now; const revision = snapshot.revision++
  if (!db.compareAndSwapKv(KEY, snapshot, revision)) throw new Error('Memory clients changed. Refresh and retry.')
}
export function authenticateMemoryClient(db: WorldDb, token: string, worldId: string, now = Date.now()): MemoryClient | null {
  if (memoryTokenWorld(token) !== worldId) return null
  const digest = Buffer.from(hash(token))
  const client = read(db).clients.find((client) => client.worldId === worldId && client.revokedAt === null && client.expiresAt > now && client.tokenHash.length === digest.length && timingSafeEqual(Buffer.from(client.tokenHash), digest))
  return client ? structuredClone(client) : null
}
