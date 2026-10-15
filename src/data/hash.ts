// Content hashes for the archive manifest, the U0 round-trip check ("record hashes
// identical") and, later, checkpoint cache keys. The canonical form is independent of key
// insertion order and of which adapter produced the record, so a record that went through
// IndexedDB, an export and an import hashes the same as the original.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace, arrays in
 * order. Follows JSON.stringify for everything else (undefined members and functions are
 * dropped, non-finite numbers become null, toJSON is honoured) so it agrees with what an
 * export writes and an import reads back.
 */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value)
  return out === undefined ? 'null' : JSON.stringify(out)
}

function canonicalize(value: unknown): Json | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON()
  }
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      // -0 and 0 serialise identically through JSON; keep that so a round trip cannot differ.
      return Number.isFinite(value) ? value : null
    case 'bigint':
      throw new TypeError('canonicalJson: BigInt is not representable in JSON')
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  if (Array.isArray(value)) return value.map((v) => canonicalize(v) ?? null)
  if (ArrayBuffer.isView(value)) throw new TypeError('canonicalJson: binary data must be hashed with hashBytes')
  const obj = value as Record<string, unknown>
  const sorted: { [k: string]: Json } = {}
  for (const key of Object.keys(obj).sort()) {
    const v = canonicalize(obj[key])
    if (v !== undefined) sorted[key] = v
  }
  return sorted
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function toHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]]
  return s
}

/** SHA-256 hex of raw bytes (or a Blob, read once). */
export async function hashBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const buf: BufferSource =
    data instanceof Blob ? await data.arrayBuffer() : data instanceof Uint8Array ? (data as Uint8Array<ArrayBuffer>) : data
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
}

/** SHA-256 hex of a string's UTF-8 bytes. */
export async function hashText(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text))
}

/** SHA-256 hex of a value's canonical JSON. */
export async function hashJson(value: unknown): Promise<string> {
  return hashText(canonicalJson(value))
}

/**
 * Order-independent hash of a record set: the canonical JSON of the records sorted by id.
 * Callers decide whether trash is included (the archive hashes every stored record).
 */
export async function hashRecords(records: readonly { id: string }[]): Promise<string> {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return hashText(canonicalJson(sorted))
}
