import type { SplatBlock } from '../../../domain/types.ts'

// Splat format sniffing from bytes (+ file name as a fallback). Pure: no Spark import, so the
// HUD can call it on a picked file's head before starting the worker.
//
// Magic numbers:
//   SPZ v1–3   gzip (1f 8b) wrapping an "NGSP" header
//   SPZ v4     raw "NGSP" with version 4 (converted to v3 in the browser, see spzV4.ts)
//   PLY        "ply\n" (or "ply\r\n")
//   SOG        zip ("PK\3\4") holding meta.json + webp planes
//   RAD        "RAD0" (Spark's own paged format)
//   .splat / .ksplat have no magic: only the extension identifies them.

export type SourceFormat = SplatBlock['sourceFormat']

export interface SniffResult {
  format: SourceFormat
  /** Raw (un-gzipped) NGSP version 4: needs the v4 → v3 repack before Spark can read it. */
  spzV4: boolean
  /** How the format was decided. 'extension' formats are unverified until decode. */
  via: 'magic' | 'extension' | 'none'
}

/** File names that make up a SOG zip (PlayCanvas "SOGS" bundle). */
const SOG_MEMBERS = /^(meta\.json|means_[lu]\.webp|quats\.webp|scales\.webp|sh0\.webp|shN_(centroids|labels)\.webp)$/

export function extensionOf(name: string | undefined): string {
  if (!name) return ''
  const clean = name.split(/[?#]/, 1)[0]
  const base = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 || dot === base.length - 1 ? '' : base.slice(dot + 1).toLowerCase()
}

const BY_EXTENSION: Readonly<Record<string, SourceFormat>> = {
  spz: 'spz',
  ply: 'ply',
  splat: 'splat',
  ksplat: 'ksplat',
  sog: 'sog',
  rad: 'rad',
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8)
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < Math.min(to, bytes.length); i++) s += String.fromCharCode(bytes[i])
  return s
}

const NGSP = 0x5053474e
const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_EOCD = 0x06054b50

/**
 * Names in a zip. With the whole file, read the central directory (authoritative: meta.json
 * is usually the last member). With only a head, fall back to the first local header.
 */
export function zipEntryNames(bytes: Uint8Array): string[] {
  if (bytes.length < 30 || u32(bytes, 0) !== ZIP_LOCAL) return []
  // End of central directory: 22 B + up to 64 KiB comment, scanned backwards.
  const stop = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (u32(bytes, i) !== ZIP_EOCD) continue
    const count = u16(bytes, i + 10)
    let p = u32(bytes, i + 16)
    const names: string[] = []
    for (let k = 0; k < count && p + 46 <= bytes.length && u32(bytes, p) === ZIP_CENTRAL; k++) {
      const nameLen = u16(bytes, p + 28)
      const extraLen = u16(bytes, p + 30)
      const commentLen = u16(bytes, p + 32)
      names.push(ascii(bytes, p + 46, p + 46 + nameLen))
      p += 46 + nameLen + extraLen + commentLen
    }
    if (names.length > 0) return names
    break
  }
  const nameLen = u16(bytes, 26)
  return [ascii(bytes, 30, 30 + nameLen)]
}

/** Decide the format of a splat file from its first bytes (all of them for SOG certainty). */
export function sniffSplat(bytes: Uint8Array, name?: string): SniffResult {
  const ext = BY_EXTENSION[extensionOf(name)]
  if (bytes.length >= 4) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return { format: 'spz', spzV4: false, via: 'magic' }
    const magic = u32(bytes, 0)
    if (magic === NGSP) {
      const version = bytes.length >= 8 ? u32(bytes, 4) : 0
      return { format: 'spz', spzV4: version === 4, via: 'magic' }
    }
    if (ascii(bytes, 0, 4) === 'ply\n' || ascii(bytes, 0, 5) === 'ply\r\n') return { format: 'ply', spzV4: false, via: 'magic' }
    if (ascii(bytes, 0, 4) === 'RAD0') return { format: 'rad', spzV4: false, via: 'magic' }
    if (magic === ZIP_LOCAL) {
      const names = zipEntryNames(bytes)
      if (names.some((n) => n === 'meta.json' || n.endsWith('/meta.json'))) return { format: 'sog', spzV4: false, via: 'magic' }
      // Only the head was given: the first member of a SOG zip is one of its planes.
      if (names.length === 1 && SOG_MEMBERS.test(names[0].split('/').pop() ?? '')) return { format: 'sog', spzV4: false, via: 'magic' }
      if (ext === 'sog') return { format: 'sog', spzV4: false, via: 'extension' }
      return { format: 'unknown', spzV4: false, via: 'none' }
    }
  }
  // No magic: .splat (32 B records) and .ksplat are identified by name only.
  if (ext === 'splat' || ext === 'ksplat') return { format: ext, spzV4: false, via: 'extension' }
  return { format: 'unknown', spzV4: false, via: 'none' }
}

/** One-line description for errors and the HUD. */
export function describeFormat(r: SniffResult): string {
  if (r.format === 'spz') return r.spzV4 ? 'SPZ v4' : 'SPZ'
  if (r.format === 'unknown') return 'unknown format'
  return r.format.toUpperCase()
}

export const ACCEPTED_EXTENSIONS = ['.spz', '.ply', '.splat', '.ksplat', '.sog', '.rad'] as const
