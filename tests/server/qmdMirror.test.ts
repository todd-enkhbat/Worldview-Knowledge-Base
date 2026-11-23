import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { expect, it } from 'vitest'
import { buildQmdMirror, qmdMirrorZip, resolveQmdHits, writeQmdMirror } from '../../server/qmdMirror.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

function corpus(): KnowledgeSnapshot {
  const text = 'Reserve eighteen hours. 🧠 Keep the original evidence.'
  return { schemaVersion: 1, revision: 1, jobs: [], proposals: [], imports: [],
    sources: [{ id: '../source', externalId: 'a/notes.md', title: 'Same note', kind: 'document', createdAt: 1, updatedAt: 1, aiAllowed: true, excluded: false, tags: [], currentVersionId: 'v1' }],
    versions: [{ id: 'v1', sourceId: '../source', text, contentHash: 'hash', originalBlobId: 'blob', originalName: 'notes.md', createdAt: 1, authoredAt: 1, origin: 'import' }],
    passages: [{ id: 'passage', sourceId: '../source', versionId: 'v1', title: 'Same note', text, start: 0, end: text.length, role: 'human', authoredAt: 1 }],
  }
}

it('exports a scoped mirror with full identity and safe filenames, keeping the source authority intact', () => {
  const snapshot = corpus(), before = structuredClone(snapshot), options = { liveNodeIds: new Set<string>() }
  const mirror = buildQmdMirror(snapshot, options)
  expect(mirror.files).toHaveLength(1)
  expect(mirror.files[0].path).toMatch(/^[a-f0-9]{64}\.md$/)
  const archive = unzipSync(qmdMirrorZip(mirror))
  expect(strFromU8(archive[mirror.files[0].path])).toContain(snapshot.passages[0].text)
  expect(JSON.parse(strFromU8(archive['worldview-manifest.json'])).entries[0]).toMatchObject({ sourceId: '../source', versionId: 'v1', passageId: 'passage' })
  expect(snapshot).toEqual(before)
  expect(buildQmdMirror(snapshot, { ...options, filters: { sourceIds: [] } }).files).toEqual([])
  expect(buildQmdMirror(snapshot, { ...options, filters: { role: 'assistant' } }).files).toEqual([])
  expect(() => buildQmdMirror(snapshot, { ...options, maxBytes: 1 })).toThrow(/scope/)
})

it('rechecks revocation, version, speaker and exact retained text before resolving native results', () => {
  const snapshot = corpus(), options = { liveNodeIds: new Set<string>() }, mirror = buildQmdMirror(snapshot, options)
  const rows = [{ file: `qmd://${mirror.manifest.collection}/${mirror.files[0].path}`, score: 0.9 }, { file: '/etc/passwd', score: 1 }, { file: 'qmd://wrong-space/' + mirror.files[0].path, score: 1 }]
  expect(resolveQmdHits(rows, mirror, snapshot, options)).toMatchObject([{ id: 'passage', text: snapshot.passages[0].text }])
  snapshot.sources[0].aiAllowed = false
  expect(resolveQmdHits(rows, mirror, snapshot, options)).toEqual([])
  snapshot.sources[0].aiAllowed = true
  snapshot.sources[0].currentVersionId = 'v2'
  expect(resolveQmdHits(rows, mirror, snapshot, options)).toEqual([])
  snapshot.sources[0].currentVersionId = 'v1'
  snapshot.versions[0].text = 'Edited in place'
  expect(resolveQmdHits(rows, mirror, snapshot, options)).toEqual([])
})

it('does not export deleted world projections or fabricate evidence from a native snippet', () => {
  const snapshot = corpus(), options = { liveNodeIds: new Set<string>() }, mirror = buildQmdMirror(snapshot, options)
  snapshot.sources[0].nodeId = 'deleted-node'
  expect(resolveQmdHits([{ file: mirror.files[0].path }], mirror, snapshot, options)).toEqual([])
  expect(buildQmdMirror(snapshot, options).files).toEqual([])
})

it('rejects clamped/fractional citation offsets and malformed native URI escapes', () => {
  const snapshot = corpus(), options = { liveNodeIds: new Set<string>() }, mirror = buildQmdMirror(snapshot, options)
  expect(resolveQmdHits([{ file: `qmd://${mirror.manifest.collection}/%invalid` }], mirror, snapshot, options)).toEqual([])
  snapshot.passages[0].end++
  expect(buildQmdMirror(snapshot, options).files).toEqual([])
  snapshot.passages[0].end--
  snapshot.passages[0].start = 0.5
  expect(buildQmdMirror(snapshot, options).files).toEqual([])
})

it('writes a disposable index into an empty directory and refuses to overwrite an existing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qmd-mirror-'))
  try {
    const mirror = buildQmdMirror(corpus(), { liveNodeIds: new Set<string>() })
    await writeQmdMirror(root, mirror)
    expect((await readFile(join(root, mirror.files[0].path), 'utf8'))).toContain('eighteen hours')
    await expect(writeQmdMirror(root, mirror)).rejects.toThrow(/left untouched/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
