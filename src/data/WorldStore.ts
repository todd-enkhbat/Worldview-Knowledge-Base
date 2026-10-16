import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'

// Storage adapter. Browser storage is the only copy of the user's world, so every
// implementation must be durable, atomic per call, and exportable (see archive.ts).
// Implementations: memoryStore (tests, private-mode fallback) and idbStore
// (IndexedDB for records/events/settings/asset meta, OPFS for blob bytes).
// Phase 4 adds httpStore: the SQLite engine (server/) over HTTP, behind the same interface.

export interface BlobInput {
  meta: AssetMeta
  data: Blob | Uint8Array
}

export interface StoreInfo {
  kind: 'memory' | 'idb' | 'sqlite'
  /** Where blob bytes live. 'idb' is the fallback when OPFS is unavailable; 'server' is the engine's blob directory. */
  blobBackend: 'memory' | 'opfs' | 'idb' | 'server'
}

export interface WorldStore {
  readonly info: StoreInfo

  // settings
  getSettings(): Promise<WorldSettings | null>
  putSettings(s: WorldSettings): Promise<void>

  // records (soft-deleted ones included; callers filter on deletedAt)
  listNodes(): Promise<NodeRecord[]>
  getNode(id: string): Promise<NodeRecord | undefined>
  putNode(n: NodeRecord): Promise<void>
  /** Atomic multi-record write (import, placement re-layout, seed). */
  putNodes(ns: NodeRecord[]): Promise<void>
  /** Hard delete. Only for trash purge (after retention) and import-replace. */
  deleteNode(id: string): Promise<void>

  // interaction event log (append-only; compaction is an explicit user action)
  appendEvent(e: InteractionEvent): Promise<void>
  listEvents(sinceT?: number): Promise<InteractionEvent[]>
  clearEvents(beforeT?: number): Promise<number>

  // blobs (assets)
  putBlob(input: BlobInput): Promise<void>
  getBlob(id: string): Promise<Blob | undefined>
  getAssetMeta(id: string): Promise<AssetMeta | undefined>
  listAssets(): Promise<AssetMeta[]>
  deleteBlob(id: string): Promise<void>

  // key/value for small app state (auto-backup directory handle, checkpoint cache index, …)
  getKv<T = unknown>(key: string): Promise<T | undefined>
  putKv(key: string, value: unknown): Promise<void>
  deleteKv(key: string): Promise<void>

  /** Remove everything (records, events, settings, assets, kv). */
  wipe(): Promise<void>
  close(): void
}

export type StoreChange =
  | { type: 'nodes'; ids: string[] }
  | { type: 'settings' }
  | { type: 'events' }
  | { type: 'assets'; ids: string[] }
  | { type: 'wipe' }
  | { type: 'import' }
