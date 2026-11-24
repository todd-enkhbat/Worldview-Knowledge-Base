/** Disposable local trigram index. It never sends document text to a service. */
export interface LocalSearchRecord { id: string; text: string }
export const foldSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
const grams = (value: string, size: number) => { const found = new Set<string>(); for (let i = 0; i <= value.length - size; i++) found.add(value.slice(i, i + size)); return found }
export class LocalTextIndex {
  private records = new Map<string, string>()
  private postings = new Map<string, Set<string>>()
  /** Reuses unchanged records and removes stale identities after a corpus revision. */
  update(records: readonly LocalSearchRecord[]): this {
    const incoming = new Set(records.map((entry) => entry.id))
    for (const id of this.records.keys()) if (!incoming.has(id)) this.remove(id)
    for (const record of records) {
      const text = foldSearch(record.text)
      if (this.records.get(record.id) === text) continue
      this.remove(record.id); this.records.set(record.id, text)
      for (const gram of grams(text, 3)) { const ids = this.postings.get(gram) ?? new Set<string>(); ids.add(record.id); this.postings.set(gram, ids) }
    }
    return this
  }
  private remove(id: string) {
    const text = this.records.get(id)
    if (text === undefined) return
    for (const gram of grams(text, 3)) { const ids = this.postings.get(gram); ids?.delete(id); if (!ids?.size) this.postings.delete(gram) }
    this.records.delete(id)
  }
  search(query: string): Set<string> {
    const terms = [...new Set(foldSearch(query).trim().split(/\s+/).filter(Boolean))].slice(0, 64)
    if (!terms.length) return new Set(this.records.keys())
    const lists = terms.flatMap((term) => [...grams(term, 3)].map((gram) => this.postings.get(gram) ?? new Set<string>())).sort((a, b) => a.size - b.size)
    const candidates = lists.length ? [...lists[0]] : [...this.records.keys()]
    return new Set(candidates.filter((id) => lists.every((list) => list.has(id)) && terms.every((term) => this.records.get(id)?.includes(term))))
  }
}

