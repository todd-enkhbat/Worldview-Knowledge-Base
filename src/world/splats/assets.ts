import { getStore } from '../../data/repo.ts'

// Read splat blobs (proxy / interior / thumbnail) back out of the WorldStore (OPFS or IDB).
// Ingest writes them through src/data/scenes.ts; the renderer only ever reads.

export class MissingAssetError extends Error {
  readonly assetId: string
  constructor(assetId: string) {
    super(`Splat asset ${assetId} is missing from browser storage`)
    this.name = 'MissingAssetError'
    this.assetId = assetId
  }
}

/** The stored blob, or null when it is gone (deleted, or storage was cleared). */
export async function loadSplatBlob(assetId: string): Promise<Blob | null> {
  return (await getStore().getBlob(assetId)) ?? null
}

/** Bytes of a stored splat asset (an SPZ v3 file for proxies and interiors). Throws MissingAssetError. */
export async function loadSplatBytes(assetId: string): Promise<Uint8Array> {
  const blob = await loadSplatBlob(assetId)
  if (!blob) throw new MissingAssetError(assetId)
  return new Uint8Array(await blob.arrayBuffer())
}
