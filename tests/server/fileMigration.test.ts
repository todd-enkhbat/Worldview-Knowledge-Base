import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { load } from 'sqlite-vec'
import { expect, it } from 'vitest'
import { openWorldDb } from '../../server/worldDb.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'

it('upgrades an existing v1 database without changing records or attachment bytes/metadata', () => {
  const folder = mkdtempSync(join(tmpdir(), 'worldview-v1-'))
  const path = join(folder, 'world.sqlite')
  let upgraded: ReturnType<typeof openWorldDb> | null = null
  try {
    const old = new DatabaseSync(path, { allowExtension: true })
    load(old)
    const schema = readFileSync(new URL('../../src/domain/schema.sql', import.meta.url), 'utf8').replaceAll(", 'file'", '')
    old.exec(schema)
    old.exec('PRAGMA user_version = 1')
    old.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-text', 'text', 'text/plain', 3, 1, null, Buffer.from('old'))
    old.close()
    upgraded = openWorldDb(path)
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    expect(upgraded.getAssetMeta('legacy-text')).toMatchObject({ kind: 'text', bytes: 3, mime: 'text/plain' })
    expect(upgraded.db.prepare('SELECT data FROM assets WHERE id = ?').get('legacy-text')).toEqual({ data: new Uint8Array(Buffer.from('old')) })
    const record = buildDemoWorld(Date.UTC(1990, 0, 1), Date.UTC(2026, 10, 22))[0]
    record.attachments = [{ id: crypto.randomUUID(), kind: 'file', name: 'original.pdf', mime: 'application/pdf', bytes: 15, blobId: 'original-pdf', createdAt: 1 }]
    record.corpusExcluded = true
    upgraded.putNodes([record])
    upgraded.putAssetMeta({ id: 'original-pdf', kind: 'file', mime: 'application/pdf', bytes: 15, createdAt: 1, nodeId: record.id })
    expect(upgraded.getNode(record.id)).toEqual(record)
    expect(upgraded.getAssetMeta('original-pdf')?.kind).toBe('file')
    expect(upgraded.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  } finally { upgraded?.close(); rmSync(folder, { recursive: true, force: true }) }
})
