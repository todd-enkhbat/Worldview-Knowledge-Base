/** Revision checks shared by the browser adapters and the SQLite API. */
export function stateRevision(value: unknown): number {
  if (value === undefined) return 0
  if (!value || typeof value !== 'object') return -1
  const revision = (value as { revision?: unknown }).revision
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : -1
}

export function assertRevisionMutation(value: unknown, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || stateRevision(value) !== expectedRevision + 1) {
    throw new Error('A versioned state write must advance its expected revision by exactly one')
  }
}

export class WorldStateConflictError extends Error {
  override name = 'WorldStateConflictError'
  constructor() {
    super('This workspace changed while this operation was running. Refresh and retry; no newer changes were overwritten.')
  }
}
