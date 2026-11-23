import { zipSync, strToU8 } from 'fflate'
import { ARCHETYPES, type Archetype, type Link, type NodeRecord, type TemporalPrecision } from '../domain/types.ts'
import type { NodeDraftInput } from './repo.ts'
import { extractVaultLinks, parseVaultMetadata, resolveVaultLink, type VaultCandidate } from '../knowledge/vault.ts'

// The Obsidian bridge (milestone 1). A vault is one markdown file per note: YAML frontmatter
// (id, kind, date, precision, tags, links as [[wikilinks]]) and the note's body verbatim.
// Export also writes a `hyperspace` line holding the rest of the record as JSON, so a vault
// exported here re-imports losslessly; a vault from anywhere else is read from its
// frontmatter, wikilinks and file dates. Pure: no DOM, no store.

export interface VaultFile {
  /** Vault-relative path, e.g. "Ideas/Entropy.md". */
  path: string
  text: string
  /** File modification time (epoch ms), the date of last resort. */
  lastModified: number
}

const HYPERSPACE_KEY = 'hyperspace'
const LINK_KINDS = new Set<string>(['relates', 'supports', 'contradicts', 'derives', 'influenced-by'])

// ─── frontmatter ─────────────────────────────────────────────────────────────────────

type FmValue = string | string[]

/** Minimal YAML frontmatter: `key: value`, `key: [a, b]` and indented `- item` lists. */
export function splitFrontmatter(text: string): { fm: Record<string, FmValue>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm: Record<string, FmValue> = {}
  let listKey: string | null = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line)
    if (item && listKey) {
      const cur = fm[listKey]
      const v = unquote(item[1].trim())
      fm[listKey] = Array.isArray(cur) ? [...cur, v] : [v]
      continue
    }
    const kv = /^([A-Za-z0-9_\-. ]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].trim()
    const raw = kv[2].trim()
    listKey = null
    if (raw === '') {
      listKey = key
      fm[key] = []
    } else if (raw.startsWith('[') && raw.endsWith(']') && !raw.startsWith('[[')) {
      fm[key] = raw
        .slice(1, -1)
        .split(',')
        .map((x) => unquote(x.trim()))
        .filter(Boolean)
    } else {
      fm[key] = unquote(raw)
    }
  }
  return { fm, body: text.slice(m[0].length) }
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'")
    try { return JSON.parse(s) as string } catch { return s }
  }
  return s
}

const yamlString = (s: string) => JSON.stringify(s)

// ─── dates ───────────────────────────────────────────────────────────────────────────

/** "2019", "2019-05", "2019-05-01" or an ISO timestamp → epoch ms (UTC) and its precision. */
export function parseVaultDate(s: string): { epochMs: number; precision: TemporalPrecision } | null {
  const t = s.trim()
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(t)
  if (m) {
    const date = new Date(0)
    date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1))
    if (date.getUTCFullYear() !== +m[1] || date.getUTCMonth() !== +(m[2] ?? 1) - 1 || date.getUTCDate() !== +(m[3] ?? 1)) return null
    return { epochMs: date.getTime(), precision: m[3] ? 'day' : m[2] ? 'month' : 'year' }
  }
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(t)
  if (!iso || !parseVaultDate(iso[1]) || +iso[2] > 23 || +iso[3] > 59 || +(iso[4] ?? 0) > 59 || +(iso[5] ?? 0) > 23 || +(iso[6] ?? 0) > 59) return null
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? { epochMs: ms, precision: 'minute' } : null
}

export function formatVaultDate(epochMs: number, precision: TemporalPrecision): string {
  const iso = new Date(epochMs).toISOString()
  if (precision === 'year') return iso.slice(0, 4)
  if (precision === 'month') return iso.slice(0, 7)
  if (precision === 'day') return iso.slice(0, 10)
  return iso
}

// ─── wikilinks ───────────────────────────────────────────────────────────────────────

/** Targets of [[Target]], [[Target|alias]] and [[Target#heading]] (embeds included). */
export function wikilinkTargets(text: string): string[] {
  return extractVaultLinks(text).map((reference) => reference.target).filter(Boolean)
}

const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop()!.replace(/\.md$/i, '')
const key = (title: string) => title.trim().toLowerCase()

// ─── import ──────────────────────────────────────────────────────────────────────────

export interface ParseOptions {
  /** Kind for notes whose frontmatter names none (Claude can re-kind them later). */
  defaultKind?: Archetype
  makeId?: () => string
  now?: number
}

export interface ParsedVault {
  drafts: NodeDraftInput[]
  /** Per draft id: vault paths (or bare names) of files the note embeds or links, to attach. */
  files: Map<string, string[]>
  /** Notes read back losslessly from a `hyperspace` line (exported by this app). */
  lossless: number
  /** Wikilinks whose target is not in the vault. */
  unresolved: number
  diagnostics: { path: string; target: string; reason: 'missing' | 'ambiguous' | 'invalid'; candidates: string[] }[]
}

/** Read a vault's markdown files into node drafts with links resolved by note name. */
export function parseVault(files: readonly VaultFile[], opts: ParseOptions = {}): ParsedVault {
  const makeId = opts.makeId ?? (() => crypto.randomUUID())
  const now = opts.now ?? Date.now()
  const md = files.filter((f) => /\.md$/i.test(f.path) && !/(^|\/)\.(obsidian|trash)\//.test(f.path))

  interface Pending {
    draft: NodeDraftInput
    targets: { title: string; kind: Link['kind'] }[]
    path: string
  }
  const pending: Pending[] = []
  const candidates: VaultCandidate[] = []
  const fileRefs = new Map<string, string[]>()
  let lossless = 0

  for (const f of md) {
    const { fm, body } = splitFrontmatter(f.text)
    const name = baseName(f.path)
    const hs = typeof fm[HYPERSPACE_KEY] === 'string' ? tryJson(fm[HYPERSPACE_KEY]) : null
    if (hs && typeof hs.id === 'string' && typeof hs.archetype === 'string') {
      // Exported here: the record exactly, with the body from the file (edits in Obsidian win).
      const rec = hs as unknown as NodeRecord
      // Attachments travel as files under attachments/<note>/; blob ids are this world's own.
      const draft = { ...rec, contentMd: body, attachments: [] }
      if (rec.attachments?.length) fileRefs.set(rec.id, rec.attachments.map((a) => `attachments/${name}/${a.name}`))
      pending.push({ draft, targets: [], path: f.path })
      candidates.push({ id: draft.id, path: f.path, aliases: [draft.title] })
      lossless++
      continue
    }

    const title = (typeof fm.title === 'string' && fm.title.trim()) || name
    const dateStr = [fm.date, fm.created, fm.created_at, fm.createdAt].find((v): v is string => typeof v === 'string')
    const date = (dateStr && parseVaultDate(dateStr)) || { epochMs: f.lastModified || now, precision: 'day' as const }
    const kindRaw = typeof fm.kind === 'string' ? fm.kind : typeof fm.type === 'string' ? fm.type : ''
    const archetype = (ARCHETYPES as readonly string[]).includes(kindRaw) ? (kindRaw as Archetype) : (opts.defaultKind ?? 'document')
    const fmTags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === 'string' ? fm.tags.split(/[,\s]+/) : []
    const inlineTags = [...body.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)].map((m) => m[1])
    const tags = [...new Set([...fmTags, ...inlineTags].map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean))]

    // Frontmatter links may carry a kind ("supports [[Note]]", as this app exports them).
    const fmLinks = Array.isArray(fm.links) ? fm.links : typeof fm.links === 'string' ? [fm.links] : []
    const targets: { title: string; kind: Link['kind'] }[] = []
    for (const entry of fmLinks) {
      const k = /^\s*([a-z-]+)\s+\[\[/.exec(entry)?.[1]
      const kind = k && LINK_KINDS.has(k) ? (k as Link['kind']) : 'relates'
      for (const t of wikilinkTargets(entry)) targets.push({ title: t, kind })
    }
    for (const t of wikilinkTargets(body)) targets.push({ title: t, kind: 'relates' })
    // ![[photo.jpg]] and [[paper.pdf]]: files in the vault become the note's attachments.
    const files = targets.map((t) => t.title).filter((t) => /\.[a-z0-9]{1,8}$/i.test(t) && !/\.md$/i.test(t))

    const id = makeId()
    if (files.length) fileRefs.set(id, [...new Set(files)])
    pending.push({
      path: f.path,
      draft: {
        id,
        archetype,
        title,
        contentMd: body,
        tags,
        temporalOrigin: date.epochMs,
        temporalPrecision: date.precision,
        provenance: { source: 'obsidian', ref: f.path, keptAt: now, sourceMetadata: { vaultPath: f.path, ...parseVaultMetadata(f.text) } },
      },
      targets,
    })
    const aliases = fm.aliases
    candidates.push({ id, path: f.path, aliases: [title, ...(Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? [aliases] : [])] })
  }

  let unresolved = 0
  const diagnostics: ParsedVault['diagnostics'] = []
  for (const p of pending) {
    if (!p.targets.length) continue
    const seen = new Set<string>()
    const links: Link[] = []
    for (const t of p.targets) {
      if (/\.[a-z0-9]{1,8}$/i.test(t.title) && !/\.md$/i.test(t.title)) continue
      const resolution = resolveVaultLink(p.path, t.title, candidates)
      if (resolution.status !== 'resolved') {
        unresolved++
        diagnostics.push({ path: p.path, target: t.title, reason: resolution.status, candidates: resolution.candidates })
        continue
      }
      const target = resolution.id
      if (target === p.draft.id || seen.has(target)) continue
      seen.add(target)
      links.push({ targetId: target, kind: t.kind, createdAt: now })
    }
    p.draft.links = links
  }
  return { drafts: pending.map((p) => p.draft), files: fileRefs, lossless, unresolved, diagnostics }
}

function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ─── export ──────────────────────────────────────────────────────────────────────────

/** File-safe note name; Obsidian forbids * " \ / < > : | ? # ^ [ ] in names. */
export function noteFileName(title: string): string {
  const s = title.replace(/[*"\\/<>:|?#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return s || 'Untitled'
}

/** Deduplicated note names for the live records, by id. */
function noteNames(live: readonly NodeRecord[]): Map<string, string> {
  const names = new Map<string, string>()
  const used = new Set<string>()
  for (const r of live) {
    let n = noteFileName(r.title)
    for (let i = 2; used.has(key(n)); i++) n = `${noteFileName(r.title)} (${i})`
    used.add(key(n))
    names.set(r.id, n)
  }
  return names
}

/** Where each live record's attachments go in the vault, with the blob that holds them. */
export function vaultAttachments(records: readonly NodeRecord[]): { path: string; blobId: string }[] {
  const live = records.filter((r) => r.deletedAt === null)
  const names = noteNames(live)
  return live.flatMap((r) => r.attachments.map((a) => ({ path: `attachments/${names.get(r.id)}/${a.name}`, blobId: a.blobId })))
}

/** One markdown file per live record, at "<Note name>.md" (names deduplicated). */
export function exportVault(records: readonly NodeRecord[]): Map<string, string> {
  const live = records.filter((r) => r.deletedAt === null)
  const names = noteNames(live)
  const files = new Map<string, string>()
  for (const r of live) {
    const { contentMd, ...rest } = r
    const rawFrontmatter = r.provenance?.source !== 'omnibox' ? r.provenance?.sourceMetadata?.rawFrontmatter : undefined
    const owned = new Set(['title', 'id', 'kind', 'date', 'precision', 'tags', 'links', 'source', 'attachments', 'url', 'place', HYPERSPACE_KEY])
    let skip = false
    const unknown: string[] = []
    if (typeof rawFrontmatter === 'string') for (const line of rawFrontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '').split(/\r?\n/)) {
      const property = /^([^\s:#][^:]*):/.exec(line)
      if (property) skip = owned.has(property[1])
      if (!skip) unknown.push(line)
    }
    const lines = [
      '---',
      ...unknown,
      `title: ${yamlString(r.title)}`,
      `id: ${r.id}`,
      `kind: ${r.archetype}`,
      `date: ${formatVaultDate(r.temporalOrigin, r.temporalPrecision)}`,
      `precision: ${r.temporalPrecision}`,
      `tags: [${r.tags.map(yamlString).join(', ')}]`,
    ]
    const linked = r.links.filter((l) => names.has(l.targetId))
    if (linked.length) {
      lines.push('links:')
      for (const l of linked) lines.push(`  - ${yamlString(`${l.kind} [[${names.get(l.targetId)}]]`)}`)
    }
    if (r.provenance && r.provenance.source !== 'omnibox' && r.provenance.ref) lines.push(`source: ${yamlString(r.provenance.ref)}`)
    if (r.attachments.length) {
      lines.push('attachments:')
      for (const a of r.attachments) lines.push(`  - ${yamlString(`[[attachments/${names.get(r.id)}/${a.name}]]`)}`)
    }
    for (const e of r.embeds ?? []) {
      if (e.url) lines.push(`${e.kind === 'place' ? 'place' : 'url'}: ${yamlString(e.url)}`)
      else if (e.place) lines.push(`place: ${yamlString([e.place.name, e.place.address].filter(Boolean).join(', '))}`)
    }
    lines.push(`${HYPERSPACE_KEY}: ${yamlString(JSON.stringify(rest))}`, '---', '')
    files.set(`${names.get(r.id)}.md`, lines.join('\n') + contentMd)
  }
  return files
}

/** The vault as a .zip (one folder, ready to open in Obsidian). */
export function zipVault(files: ReadonlyMap<string, string | Uint8Array>, folder = 'Worldview'): Uint8Array {
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}
  // Notes compress well; originals (photos, video, zips) mostly do not, so they are stored.
  for (const [path, data] of files) entries[`${folder}/${path}`] = typeof data === 'string' ? strToU8(data) : [data, { level: 0 }]
  return zipSync(entries, { level: 6 })
}
