// A read-only look inside a SQLite database file, in plain TypeScript (no wasm, no server):
// the tables and views from sqlite_schema, each table's row count and first rows. Enough for a
// preview Claude can read and for a note's description. It walks table b-trees only (no
// indexes), reads records from their leaf cells, and follows overflow pages for long values.
// File format: https://www.sqlite.org/fileformat2.html

export interface SqliteTable {
  name: string
  type: 'table' | 'view'
  sql: string
  /** Rows in a table (null for views, or when the b-tree could not be walked). */
  rows: number | null
  /** The first few rows, each value as text (long values shortened). */
  sample: string[][]
}

const HEADER = 'SQLite format 3\u0000'
const MAX_PAGES_WALKED = 200_000

export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false
  for (let i = 0; i < 16; i++) if (bytes[i] !== HEADER.charCodeAt(i)) return false
  return true
}

/** Reads a SQLite file's tables. Throws on files that are not SQLite or are damaged. */
export function readSqlite(bytes: Uint8Array, opts: { sampleRows?: number; maxValue?: number } = {}): SqliteTable[] {
  if (!isSqlite(bytes)) throw new Error('not a SQLite database')
  const sampleRows = opts.sampleRows ?? 3
  const maxValue = opts.maxValue ?? 80
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const raw = dv.getUint16(16)
  const pageSize = raw === 1 ? 65536 : raw
  const reserved = bytes[20]
  const usable = pageSize - reserved
  const textEncoding = dv.getUint32(56)
  const decoder = new TextDecoder(textEncoding === 2 ? 'utf-16le' : textEncoding === 3 ? 'utf-16be' : 'utf-8')
  const pageCount = Math.floor(bytes.length / pageSize)
  let walked = 0

  const pageAt = (n: number) => {
    if (n < 1 || n > pageCount) throw new Error(`page ${n} is outside the file`)
    return (n - 1) * pageSize
  }

  const varint = (at: number): [number, number] => {
    let v = 0
    for (let i = 0; i < 8; i++) {
      const b = bytes[at + i]
      v = v * 128 + (b & 0x7f)
      if (b < 0x80) return [v, i + 1]
    }
    return [v * 256 + bytes[at + 8], 9]
  }

  /** The payload of a table-leaf cell, following overflow pages. */
  const payloadOf = (cell: number): Uint8Array => {
    const [size, a] = varint(cell)
    const [, b] = varint(cell + a) // rowid
    const start = cell + a + b
    const maxLocal = usable - 35
    if (size <= maxLocal) return bytes.subarray(start, start + size)
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23
    let local = minLocal + ((size - minLocal) % (usable - 4))
    if (local > maxLocal) local = minLocal
    const out = new Uint8Array(size)
    out.set(bytes.subarray(start, start + local))
    let filled = local
    let next = dv.getUint32(start + local)
    while (next && filled < size) {
      const p = pageAt(next)
      const n = Math.min(usable - 4, size - filled)
      out.set(bytes.subarray(p + 4, p + 4 + n), filled)
      filled += n
      next = dv.getUint32(p)
    }
    return out
  }

  const record = (payload: Uint8Array): (number | bigint | string | Uint8Array | null)[] => {
    const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const vi = (at: number): [number, number] => {
      let v = 0
      for (let i = 0; i < 9; i++) {
        const b = payload[at + i]
        if (i === 8) return [v * 256 + b, 9]
        v = v * 128 + (b & 0x7f)
        if (b < 0x80) return [v, i + 1]
      }
      return [v, 9]
    }
    const [headerSize, hl] = vi(0)
    const types: number[] = []
    for (let at = hl; at < headerSize; ) {
      const [t, n] = vi(at)
      types.push(t)
      at += n
    }
    const values: (number | bigint | string | Uint8Array | null)[] = []
    let at = headerSize
    for (const t of types) {
      if (t === 0) values.push(null)
      else if (t >= 1 && t <= 6) {
        const len = [0, 1, 2, 3, 4, 6, 8][t]
        let v = BigInt(0)
        for (let i = 0; i < len; i++) v = (v << BigInt(8)) | BigInt(payload[at + i] ?? 0)
        const bits = BigInt(len * 8)
        if (len && v >= BigInt(1) << (bits - BigInt(1))) v -= BigInt(1) << bits
        values.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v)
        at += len
      } else if (t === 7) {
        values.push(at + 8 <= payload.length ? pv.getFloat64(at) : null)
        at += 8
      } else if (t === 8) values.push(0)
      else if (t === 9) values.push(1)
      else if (t >= 12) {
        const len = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2
        const slice = payload.subarray(at, at + len)
        values.push(t % 2 === 0 ? slice : decoder.decode(slice))
        at += len
      } else values.push(null)
    }
    return values
  }

  /** Visit the leaf cells of the table b-tree rooted at `root`, in rowid order, until `visit` returns false. */
  const walk = (root: number, visit: (cell: number) => boolean): boolean => {
    const stack = [root]
    while (stack.length) {
      if (++walked > MAX_PAGES_WALKED) throw new Error('database too large to walk')
      const n = stack.pop()!
      const p = pageAt(n)
      const h = n === 1 ? p + 100 : p
      const kind = bytes[h]
      const cells = dv.getUint16(h + 3)
      if (kind === 0x0d) {
        for (let i = 0; i < cells; i++) if (!visit(p + dv.getUint16(h + 8 + 2 * i))) return false
      } else if (kind === 0x05) {
        // Children pushed in reverse so the leftmost is visited first.
        stack.push(dv.getUint32(h + 8))
        for (let i = cells - 1; i >= 0; i--) stack.push(dv.getUint32(p + dv.getUint16(h + 12 + 2 * i)))
      } else throw new Error(`page ${n} is not a table b-tree page`)
    }
    return true
  }

  const show = (v: number | bigint | string | Uint8Array | null): string => {
    if (v === null) return 'NULL'
    if (v instanceof Uint8Array) return `<${v.length} bytes>`
    const s = String(v)
    return s.length > maxValue ? `${s.slice(0, maxValue - 1)}…` : s
  }

  const schema: { type: string; name: string; root: number; sql: string }[] = []
  walk(1, (cell) => {
    const [type, name, , root, sql] = record(payloadOf(cell))
    if (type === 'table' || type === 'view') schema.push({ type: String(type), name: String(name), root: Number(root ?? 0), sql: String(sql ?? '') })
    return true
  })

  return schema.map((s) => {
    if (s.type === 'view' || !s.root) return { name: s.name, type: 'view' as const, sql: s.sql, rows: null, sample: [] }
    const sample: string[][] = []
    let rows = 0
    try {
      walk(s.root, (cell) => {
        if (sample.length < sampleRows) sample.push(record(payloadOf(cell)).map(show))
        rows++
        return true
      })
      return { name: s.name, type: 'table' as const, sql: s.sql, rows, sample }
    } catch {
      return { name: s.name, type: 'table' as const, sql: s.sql, rows: null, sample }
    }
  })
}

/** A text preview of a database: one block per table (schema, row count, first rows). */
export function sqlitePreview(bytes: Uint8Array): string {
  let tables: SqliteTable[]
  try {
    tables = readSqlite(bytes)
  } catch (e) {
    return `A SQLite database that could not be read here (${e instanceof Error ? e.message : String(e)}).`
  }
  const shown = tables.filter((t) => !t.name.startsWith('sqlite_'))
  if (!shown.length) return 'An empty SQLite database (no tables).'
  const lines = [`A SQLite database with ${shown.length} table${shown.length === 1 ? '' : 's'}:`]
  for (const t of shown.slice(0, 40)) {
    lines.push('', `${t.type} ${t.name}${t.rows === null ? '' : ` (${t.rows.toLocaleString('en')} rows)`}`, t.sql.replace(/\s+/g, ' ').slice(0, 600))
    for (const r of t.sample) lines.push(`  ${r.join(' | ')}`)
  }
  if (shown.length > 40) lines.push('', `… and ${shown.length - 40} more`)
  return lines.join('\n')
}
