import { getStore, getWorldGeneration, isRepoReady, retainWorldBlob } from '../data/repo.ts'
import { ingestRetainedSource, knowledgeHash } from '../knowledge/index.ts'
import { articleIdentity } from './articleIdentity.ts'
import { addReadingNote, updateReadingItem } from './store.ts'

/** Explicit local capture; the URL is provenance and is never fetched by the server. */
export async function captureArticle(input: { title: string; url: string; text: string; remark?: string }): Promise<{ sourceId: string }> {
  const identity = articleIdentity(input.url), title = input.title.trim(), text = input.text.trim()
  if (!title || title.length > 300) throw new Error('Give the article a title up to 300 characters.')
  if (!text || new TextEncoder().encode(text).byteLength > 512 * 1024) throw new Error('Paste article text up to 512 KiB.')
  if ((input.remark?.length ?? 0) > 20_000) throw new Error('Keep your article note under 20,000 characters.')
  const store = getStore(), generation = getWorldGeneration()
  const current = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'worldview-article-capture.v1', url: identity.url, title, text }))
  const id = `knowledge-${await knowledgeHash(bytes)}`
  await retainWorldBlob({ meta: { id, kind: 'file', mime: 'application/json', bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes }, { store, generation })
  const source = await ingestRetainedSource({ externalId: identity.externalId, title, kind: 'document', text, authoredAt: null, messages: [{ text, role: 'third-party', authoredAt: null, start: 0, end: text.length }], metadata: { url: identity.url, canonicalUrl: identity.canonicalUrl, host: identity.host, format: 'article', captureMethod: 'paste' } }, { originalBlobId: id, originalName: 'article-capture.json', project: false, shouldWrite: current })
  if (!current()) throw new Error('The workspace changed before this article could be added to your reading list.')
  await updateReadingItem(source.id, {})
  if (input.remark?.trim()) { if (!current()) throw new Error('The workspace changed before your article note could be saved.'); await addReadingNote(source.id, input.remark.trim()) }
  return { sourceId: source.id }
}
