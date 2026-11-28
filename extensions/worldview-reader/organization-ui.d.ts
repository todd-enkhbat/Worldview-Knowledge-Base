export interface ReaderRecord {
  record: Record<string, unknown>
  connections?: { id: string; name: string; logoAssetId?: string | null }[]
  [key: string]: unknown
}
export function mountOrganizationEditor(host: HTMLElement, options: {
  actionHost?: HTMLElement | null
  request: (fields: Record<string, unknown>) => Promise<ReaderRecord>
  personLink: (id: string) => void
  companyLink: (id: string) => void
  onChange: (model: ReaderRecord) => void
  entityType?: 'person' | 'company'
}): () => void
