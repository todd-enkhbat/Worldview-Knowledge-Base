import type { ArtifactSnapshot } from './types.ts'

const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/gu, ' ')
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
/** Decisions survive re-import without retaining a plaintext copy in their identity. */
export function artifactFingerprint(pageId: string, kind: 'claim' | 'page', text: string): Promise<string> {
  const content = kind === 'page' ? text.replace(/#\/library\?passage=[^)\s]+/g, 'source-citation') : text
  return hash(`${pageId}\0${kind}\0${normalize(content)}`)
}

/** Upgrade the early local prototype's plaintext identities before any durable mutation/purge. */
export async function normalizeArtifactFingerprints(snapshot: ArtifactSnapshot): Promise<void> {
  for (const item of [...snapshot.claims, ...snapshot.tombstones]) if (!/^sha256:[a-f0-9]{64}$/.test(item.fingerprint)) item.fingerprint = await hash(item.fingerprint)
}
