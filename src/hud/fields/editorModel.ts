import { FUTURE_YEARS } from '../../domain/constants.ts'
import { formatByPrecision, truncateToPrecision } from '../../domain/time.ts'
import type { Archetype, NodeRecord, WorldSettings } from '../../domain/types.ts'
import { TITLE_MAX, makeNodeDraft, maxTemporalOrigin, slugify, type ValidationIssue, type ValidationResult } from '../../domain/validate.ts'

// Form model behind NodeEditor, kept free of React and the repo so it can be unit-tested.

/** Fields the editor owns. Everything else (anchor, slug, attachments, bookkeeping) is the repo's. */
export const EDITABLE_FIELDS = [
  'title',
  'contentMd',
  'tags',
  'temporalOrigin',
  'temporalPrecision',
  'referenceDate',
  'thermo',
  'visibility',
  'links',
  'entity',
  'demon',
] as const satisfies readonly (keyof NodeRecord)[]

/** The editable slice of a record, as a patch for updateNode / draft for createNode. */
export function editableOf(r: NodeRecord): Partial<NodeRecord> {
  const out: Record<string, unknown> = {}
  for (const k of EDITABLE_FIELDS) if (r[k] !== undefined) out[k] = r[k]
  return out as Partial<NodeRecord>
}

/** JSON with sorted keys, so { a, b } and { b, a } compare equal. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

export function sameEditable(a: NodeRecord, b: NodeRecord): boolean {
  return stableStringify(editableOf(a)) === stableStringify(editableOf(b))
}

/** Default origin for a new node: today (UTC day), kept inside [T0, now + 5 y]. */
export function defaultOrigin(settings: Pick<WorldSettings, 'T0'>, now: number): number {
  return Math.min(Math.max(truncateToPrecision(now, 'day'), settings.T0), maxTemporalOrigin(now))
}

export function newDraft(archetype: Archetype, settings: Pick<WorldSettings, 'T0'>, now: number): NodeRecord {
  return makeNodeDraft(archetype, { temporalOrigin: defaultOrigin(settings, now) }, { now })
}

/**
 * What the validator should see: the title trimmed (the repo trims on save) and, for a new
 * node, the unique slug the repo will assign, so neither raises noise the user cannot act on.
 */
export function candidateOf(draft: NodeRecord, isNew: boolean, slugs: Iterable<string>): NodeRecord {
  const title = draft.title.trim()
  if (!isNew) return title === draft.title ? draft : { ...draft, title }
  return { ...draft, title, slug: slugify(title || draft.archetype, slugs) }
}

/**
 * Errors that stop Save. Spacing (σ) is not one: a new node is placed by the repo, and an
 * edit is snapped (same date) or nudged (new date) by updateNode itself, deterministically.
 */
export function isBlocking(issue: ValidationIssue, isNew: boolean): boolean {
  if (issue.field === 'anchorXZ') return !isNew && issue.code !== 'sigma-snap' && issue.code !== 'sigma-reject'
  if (issue.field === 'slug') return !isNew
  return true
}

/** Control an issue belongs to: 'links[2].targetId' → 'links', 'thermo.mass' stays. */
export function fieldKey(field: string): string {
  return field.startsWith('links[') ? 'links' : field
}

/** Index of a link issue ('links[2].kind' → 2), else null. */
export function linkIndex(field: string): number | null {
  const m = /^links\[(\d+)\]/.exec(field)
  return m ? Number(m[1]) : null
}

export function friendlyMessage(issue: ValidationIssue, T0: number): string {
  switch (issue.code) {
    case 'title-empty':
      return 'Give it a title.'
    case 'title-long':
      return `Keep the title under ${TITLE_MAX} characters.`
    case 'before-t0':
      return `Before the world begins (${formatByPrecision(T0, 'day')}). Pick a later date, or move T0 in Settings.`
    case 'too-far-future':
      return `The world ends ${FUTURE_YEARS} years from now. Pick an earlier date.`
    case 'link-missing':
      return 'This node no longer exists. Remove the link.'
    case 'link-trashed':
      return 'This node is in the trash.'
    case 'link-duplicate':
      return 'Duplicate link.'
    case 'link-self':
      return 'A node cannot link to itself.'
    case 'demon-radius':
      return 'The radius must be greater than 0.'
    case 'demon-query-empty':
      return 'An empty query matches nothing yet.'
    case 'entity-kind':
      return 'Choose what kind of entity this is.'
    default:
      return issue.message
  }
}

export interface EditorIssues {
  /** Errors that stop Save. */
  blocking: ValidationIssue[]
  /** Friendly messages by control (fieldKey), errors then warnings. */
  errors: Map<string, string[]>
  warnings: Map<string, string[]>
  /** Per-link messages (errors win over warnings). */
  links: Map<number, string>
}

export function collectIssues(result: ValidationResult, isNew: boolean, T0: number): EditorIssues {
  const blocking = result.errors.filter((e) => isBlocking(e, isNew))
  const errors = new Map<string, string[]>()
  const warnings = new Map<string, string[]>()
  const links = new Map<number, string>()
  const add = (m: Map<string, string[]>, issue: ValidationIssue) => {
    const key = fieldKey(issue.field)
    const msg = friendlyMessage(issue, T0)
    const list = m.get(key) ?? []
    if (!list.includes(msg)) list.push(msg)
    m.set(key, list)
    const li = linkIndex(issue.field)
    if (li !== null && (m === errors || !links.has(li))) links.set(li, msg)
  }
  for (const w of result.warnings) add(warnings, w)
  for (const e of blocking) add(errors, e)
  return { blocking, errors, warnings, links }
}
