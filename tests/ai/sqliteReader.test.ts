import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isSqlite, readSqlite, sqlitePreview } from '../../src/ai/chat/sqliteReader.ts'
import { previewBytes } from '../../src/ai/chat/preview.ts'

const dir = mkdtempSync(join(tmpdir(), 'wv-sqlite-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function makeDb(name: string, fill: (db: DatabaseSync) => void, pageSize = 4096): Uint8Array {
  const file = join(dir, name)
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA page_size = ${pageSize}; PRAGMA journal_mode = DELETE;`)
  fill(db)
  db.close()
  return new Uint8Array(readFileSync(file))
}

describe('SQLite reader', () => {
  it('lists tables, views, row counts and first rows', () => {
    const bytes = makeDb('small.db', (db) => {
      db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, born INTEGER, height REAL, photo BLOB);
               CREATE TABLE empty (x TEXT);
               CREATE VIEW tall AS SELECT name FROM people WHERE height > 1.8;`)
      const ins = db.prepare('INSERT INTO people (name, born, height, photo) VALUES (?, ?, ?, ?)')
      ins.run('Ada Lovelace', 1815, 1.65, new Uint8Array([1, 2, 3]))
      ins.run('Ludwig Boltzmann', 1844, 1.83, null)
      ins.run('Émilie du Châtelet', -1, 1.7, null)
    })
    expect(isSqlite(bytes)).toBe(true)
    const tables = readSqlite(bytes)
    const people = tables.find((t) => t.name === 'people')!
    expect(people.rows).toBe(3)
    expect(people.sample[0]).toEqual(['NULL', 'Ada Lovelace', '1815', '1.65', '<3 bytes>'])
    expect(people.sample[2][1]).toBe('Émilie du Châtelet')
    expect(people.sample[2][2]).toBe('-1')
    expect(tables.find((t) => t.name === 'empty')!.rows).toBe(0)
    expect(tables.find((t) => t.name === 'tall')!.type).toBe('view')
  })

  it('walks multi-level b-trees and overflow pages', () => {
    const long = 'x'.repeat(20_000)
    const bytes = makeDb(
      'big.db',
      (db) => {
        db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
        const ins = db.prepare('INSERT INTO notes (body) VALUES (?)')
        db.exec('BEGIN')
        ins.run(long)
        for (let i = 0; i < 5000; i++) ins.run(`note ${i} ${'y'.repeat(i % 50)}`)
        db.exec('COMMIT')
      },
      1024,
    )
    const notes = readSqlite(bytes, { maxValue: 30_000 }).find((t) => t.name === 'notes')!
    expect(notes.rows).toBe(5001)
    expect(notes.sample[0][1]).toBe(long)
    expect(notes.sample[1][1]).toBe('note 0 ')
  })

  it('previews a database dropped into the chat', () => {
    const bytes = makeDb('chat.sqlite', (db) => db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('hello');"))
    const text = previewBytes('chat.sqlite', 'application/vnd.sqlite3', bytes)!
    expect(text).toContain('A SQLite database with 1 table')
    expect(text).toContain('table t (1 rows)')
    expect(text).toContain('hello')
    expect(sqlitePreview(new Uint8Array(200))).toContain('could not be read')
  })
})
