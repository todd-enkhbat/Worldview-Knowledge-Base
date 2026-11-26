// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeEncoder } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { initializeKnowledge, resetKnowledge } from '../../src/knowledge/index.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { keepNotebookNote, notePreview, noteResults } from '../../src/connections/notebookNotes.ts'

const capture = Date.parse('2026-09-20T10:00:00Z')
const selected = () => true
const corpus = async () => (await getStore().getKv<KnowledgeSnapshot>('knowledge.v1'))!
beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('TextEncoder', class extends NodeEncoder { override encode(value?: string) { return new Uint8Array(super.encode(value)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Isolated notebook import must use the supplied provider response.') }))
  vi.spyOn(Date,'now').mockReturnValue(capture)
  await initRepo({store:createMemoryStore()})
  await completeFirstRun({T0:0,start:'empty'})
  await initializeKnowledge()
})
afterEach(async () => { resetKnowledge(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function meeting(summary: string, modified: string, title = 'A conversation') {
  const reply = {structured:null,content:'<meetings_data><meeting id="meeting-7" title="' + title + '" meeting_at="2026-08-01T09:00:00Z" updated_at="' + modified + '"><private_notes>Privately noted thoughts.</private_notes><summary>' + summary + '</summary><context_for_agents>Background for the connector.</context_for_agents></meeting></meetings_data>'}
  const {rows} = noteResults('granola','meeting',reply)
  return notePreview('granola','meeting',rows[0],reply)
}
it('imports a real preview once, retains separate roles, source and capture times, and versions a provider edit', async () => {
  const initial = meeting('Summary of first meeting.','2026-08-02T09:00:00Z')
  const source = await keepNotebookNote('granola','meeting',initial,selected)
  const first = await corpus(), version = first.versions.find(v => v.id === source.currentVersionId)!
  expect(first.sources).toHaveLength(1)
  expect(version).toMatchObject({sourceId:source.id,createdAt:capture,authoredAt:Date.parse(initial.date),origin:'import',metadata:{provider:'Granola',providerId:'meeting-7',providerModifiedAt:initial.modified}})
  const passages = first.passages.filter(p => p.versionId === version.id)
  expect(passages.map(p=>[p.role,p.text])).toEqual([['unknown','Privately noted thoughts.'],['assistant','Summary of first meeting.']])
  for (const p of passages) { expect(p.authoredAt).toBe(Date.parse(initial.date)); expect(version.text.slice(p.start,p.end)).toBe(p.text) }
  expect(version.text).not.toContain('Background for the connector')
  const original = JSON.parse(await (await getStore().getBlob(version.originalBlobId))!.text())
  expect(original).toMatchObject({provider:'granola',id:initial.id,modified:initial.modified,parts:initial.parts})
  const originalCount = (await getStore().listAssets()).length
  vi.spyOn(Date,'now').mockReturnValue(capture + 1000)
  expect((await keepNotebookNote('granola','meeting',initial,selected)).currentVersionId).toBe(version.id)
  expect((await corpus()).versions).toHaveLength(1)
  expect((await getStore().listAssets()).length).toBe(originalCount)
  const updated = meeting('An edited summary.','2026-09-02T09:00:00Z')
  const revised = await keepNotebookNote('granola','meeting',updated,selected)
  const after = await corpus()
  expect(revised.id).toBe(source.id)
  expect(after.versions).toHaveLength(2)
  expect(after.versions[1]).toMatchObject({previousVersionId:version.id,createdAt:capture+1000,authoredAt:Date.parse(initial.date),metadata:{providerModifiedAt:updated.modified}})
  expect(after.versions[0]).toEqual(version)
  expect(after.versions[1].originalBlobId).not.toBe(version.originalBlobId)
  expect(after.passages.filter(p=>p.versionId===revised.currentVersionId).map(p=>p.role)).toEqual(['unknown','assistant'])
})
it('versions a provider title or modification-time change with unchanged words and keeps scratchpad authored time unknown', async () => {
  function scratch(title: string, modified: string) {
    const src = {id:'note-4',title,modified_at:modified,content:'A personal note.'}
    const list = noteResults('wispr','scratchpad',{structured:{notes:[src]},content:''})
    return notePreview('wispr','scratchpad',list.rows[0],{structured:src,content:''})
  }
  const first = await keepNotebookNote('wispr','scratchpad',scratch('Draft title','2026-08-01'),selected)
  const renamed = scratch('Edited title','2026-09-01')
  const next = await keepNotebookNote('wispr','scratchpad',renamed,selected)
  expect(next.id).toBe(first.id)
  expect(next.title).toBe(renamed.title)
  expect(next.currentVersionId).not.toBe(first.currentVersionId)
  const snapshot = await corpus()
  expect(snapshot.versions).toHaveLength(2)
  expect(snapshot.versions[1]).toMatchObject({authoredAt:null,metadata:{providerModifiedAt:'2026-09-01'},previousVersionId:first.currentVersionId})
  expect(snapshot.passages.every(p=>p.role==='unknown' && p.authoredAt===null)).toBe(true)
  await keepNotebookNote('wispr','scratchpad',renamed,selected)
  expect((await corpus()).versions).toHaveLength(2)
  const touched = scratch(renamed.title, '2026-09-05')
  const newest = await keepNotebookNote('wispr','scratchpad',touched,selected)
  expect(newest.id).toBe(first.id)
  const touchVersion = (await corpus()).versions.find(v => v.id === newest.currentVersionId)
  expect(touchVersion).toMatchObject({previousVersionId:next.currentVersionId,metadata:{providerModifiedAt:touched.modified},text:snapshot.versions[1].text})
})
