import type { KnowledgeSource } from '../knowledge/types.ts'
import type { ReadingItem, ReadingTopic } from './types.ts'

export interface CanonicalTopic { id: string; name: string; aliases: string[]; readingTopicIds: string[]; sourceIds: string[] }
export const normalizeTopicName = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[-_\s]+/g, ' ')
export const topicHref = (id: string) => `#/topics?topic=${encodeURIComponent(id)}`
/** Source tags and assigned topic names share a view identity; retained metadata stays exact. */
export function resolveTopics(sources: readonly KnowledgeSource[], topics: readonly ReadingTopic[], items: readonly ReadingItem[] = []): CanonicalTopic[] {
  const byName = new Map<string, CanonicalTopic>(), byId = new Map<string, CanonicalTopic>()
  for (const topic of [...topics].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const key = normalizeTopicName(topic.name)
    const entry = byName.get(key) ?? { id: topic.id, name: topic.name, aliases: [`tag:${key}`], readingTopicIds: [], sourceIds: [] }
    if (!entry.aliases.includes(topic.id)) entry.aliases.push(topic.id)
    entry.readingTopicIds.push(topic.id); byName.set(key, entry); byId.set(topic.id, entry)
  }
  const included = new Set(sources.filter((source) => !source.deleted && !source.excluded).map((source) => source.id))
  for (const source of sources) if (included.has(source.id)) for (const tag of source.tags) {
    const key = normalizeTopicName(tag)
    if (!key) continue
    const entry = byName.get(key) ?? { id: `tag:${key}`, name: tag, aliases: [`tag:${key}`], readingTopicIds: [], sourceIds: [] }
    if (!entry.sourceIds.includes(source.id)) entry.sourceIds.push(source.id)
    byName.set(key, entry)
  }
  for (const item of items) if (included.has(item.sourceId)) for (const id of item.topicIds) {
    const entry = byId.get(id)
    if (entry && !entry.sourceIds.includes(item.sourceId)) entry.sourceIds.push(item.sourceId)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
export const topicMatches = (topic: CanonicalTopic, ids: readonly string[] = []) => ids.some((id) => id === topic.id || topic.aliases.includes(id))
