export type Authorship = 'human' | 'assistant' | 'third-party' | 'unknown'
export type SourceKind = 'thought' | 'document' | 'chatgpt' | 'claude' | 'obsidian' | 'legacy' | 'conversation'
export type RetrievalEngine = 'local' | 'qmd-lexical' | 'qmd-hybrid'

export interface KnowledgeSource {
  id: string
  externalId: string
  title: string
  kind: SourceKind
  nodeId?: string
  currentVersionId: string
  createdAt: number
  updatedAt: number
  excluded: boolean
  aiAllowed: boolean
  tags: string[]
  /** Digest of the last world projection, so a user edit can create a source revision. */
  projectionDigest?: string
  deleted?: boolean
  pendingProjection?: boolean
  projectionEdited?: boolean
  /** Explicit vault references projected as links, with manual removals retained as constraints. */
  vaultGraph?: {
    links: { targetSourceId: string; targetNodeId: string; createdAt: number }[]
    suppressedTargets: string[]
    diagnostics: { target: string; reason: 'missing' | 'ambiguous' | 'invalid'; candidates: string[] }[]
  }
}

export interface SourceVersion {
  id: string
  sourceId: string
  contentHash: string
  originalBlobId: string
  /** A shared export original was intentionally purged when one contained source was deleted. */
  originalPurged?: boolean
  originalName: string
  text: string
  createdAt: number
  authoredAt: number | null
  origin: 'import' | 'edit' | 'legacy' | 'capture'
  previousVersionId?: string
  /** Uninterpreted source metadata is retained alongside its original bytes. */
  metadata?: Record<string, unknown>
}

export interface KnowledgePassage {
  id: string
  sourceId: string
  versionId: string
  nodeId?: string
  title: string
  text: string
  start: number
  end: number
  role: Authorship
  authoredAt: number | null
  messageId?: string
  parentId?: string
  locator?: string
}

export interface SearchHit extends KnowledgePassage {
  score: number
  trace?: {
    sourceVersionId: string
    scoreKind?: 'lexical' | 'rrf' | 'qmd'
    lexicalRank?: number
    semanticRank?: number
    fusedScore: number
    native?: { rank?: number; rerankScore?: number; lexicalScores: number[]; semanticScores: number[] }
    relevanceOnly: true
    contributions: { arm: string; rank: number; weight: number; k: number; contribution: number }[]
  }
}

export interface ImportReceipt {
  id: string
  title: string
  createdAt: number
  status: 'running' | 'complete' | 'partial' | 'failed'
  total: number
  saved: number
  unchanged: number
  failed: number
  errors: string[]
  fileBlobIds: string[]
  checkpoint: number
  /** Each input outcome is retained; retries reuse these identities and original bytes. */
  items: ImportItem[]
}

export interface ImportItem {
  path: string
  blobId: string
  mime: string
  status: 'queued' | 'saved' | 'unchanged' | 'failed'
  sourceIds: string[]
  error?: string
}

export interface KnowledgeJob {
  id: string
  kind: 'import' | 'index' | 'organize'
  title: string
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  error?: string
  completed: number
  total: number
  importId?: string
  /** Durable organization input and cursor; no model output is treated as a completed job. */
  sourceIds?: string[]
  attempts?: number
}

export interface KnowledgeProposal {
  id: string
  title: string
  explanation: string
  status: 'proposed' | 'accepted' | 'rejected'
  sourceNodeId: string
  targetNodeId: string
  evidencePassageIds: string[]
  /** Only the relationship introduced by this proposal is removed on undo. */
  introducedLink?: boolean
  introducedLinkCreatedAt?: number
}

export interface KnowledgeSnapshot {
  schemaVersion: 1
  revision: number
  sources: KnowledgeSource[]
  versions: SourceVersion[]
  passages: KnowledgePassage[]
  imports: ImportReceipt[]
  proposals: KnowledgeProposal[]
  jobs: KnowledgeJob[]
}

export interface SearchFilters {
  engine?: RetrievalEngine
  sourceIds?: readonly string[]
  role?: Authorship
  aiOnly?: boolean
  limit?: number
  includeHistory?: boolean
  kinds?: readonly SourceKind[]
  authoredAfter?: number
  /** Inclusive upper bound. Unknown dates do not match bounded date queries. */
  authoredBefore?: number
}

export interface ParsedMessage {
  id?: string
  parentId?: string
  text: string
  role: Authorship
  authoredAt: number | null
}

export interface ParsedSource {
  externalId: string
  title: string
  kind: SourceKind
  text: string
  messages: (ParsedMessage & { start: number; end: number })[]
  authoredAt: number | null
  metadata?: Record<string, unknown>
}
