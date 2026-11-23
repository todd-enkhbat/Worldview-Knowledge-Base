import { expect, it } from 'vitest'
import { rankKnowledge } from '../../src/knowledge/retrieval.ts'
import { eligibleEvidence } from '../../src/knowledge/evidencePolicy.ts'
import { buildEvidencePacket } from '../../src/knowledge/contextPacket.ts'
import { resolveArtifactEvidence } from '../../src/knowledge/artifacts/policy.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

const text = 'Exact citation evidence.'
function corpus(start: number, end: number): KnowledgeSnapshot {
  return { schemaVersion: 1, revision: 1, sources: [{ id: 'source', externalId: 'source', title: 'Citation guard', kind: 'document', currentVersionId: 'version', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }], versions: [{ id: 'version', sourceId: 'source', contentHash: 'hash', originalBlobId: 'original', originalName: 'note.md', text, createdAt: 1, authoredAt: 1, origin: 'import' }], passages: [{ id: 'passage', sourceId: 'source', versionId: 'version', title: 'Citation guard', text: text.slice(start, end), start, end, role: 'human', authoredAt: 1 }], imports: [], jobs: [], proposals: [] }
}

it.each([[.5, text.length], [0, text.length + 1], [-1, text.length], [0, text.length + .5], [2, 1]])('rejects malformed offsets %s..%s even when JavaScript slice would reproduce the purported quote', (start, end) => {
  const snapshot = corpus(start, end), passage = snapshot.passages[0]
  expect(eligibleEvidence(snapshot, passage, { aiOnly: true })).toBe(false)
  expect(rankKnowledge(snapshot, 'citation')).toEqual([])
  expect(resolveArtifactEvidence({ passageId: passage.id, sourceVersionId: passage.versionId, relation: 'supports' }, snapshot)).toBeNull()
  expect(buildEvidencePacket('citation', snapshot, [{ ...passage, score: 1 }], []).evidence).toEqual([])
})

it('rejects a passage whose retained version belongs to a different source', () => {
  const snapshot = corpus(0, text.length)
  snapshot.versions[0].sourceId = 'different-source'
  expect(rankKnowledge(snapshot, 'citation')).toEqual([])
  expect(eligibleEvidence(snapshot, snapshot.passages[0])).toBe(false)
})
