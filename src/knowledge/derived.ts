import type { NodeRecord } from '../domain/types.ts'

/** A world reference to derived knowledge must never become independent primary evidence. */
export function isArtifactProjection(record: NodeRecord | undefined): boolean {
  const provenance = record?.provenance
  return !!provenance && 'ref' in provenance && provenance.ref?.startsWith('worldview:artifact:') === true
}
