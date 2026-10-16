import {
  FUTURE_YEARS,
  MASS_RANGE,
  MAX_ANCHOR_RADIUS,
  MAX_SPAN_UNITS,
  MS_PER_YEAR,
  SIGMA,
  STEPS_PER_YEAR,
  TEMPERATURE_RANGE,
  Y_PER_YEAR,
} from './constants.ts'
import { minRadiusFor, nearestAnchor, nudgeAnchor, fnv1a32, toPlacedAnchors } from './placement.ts'
import { yOf } from './time.ts'
import {
  ARCHETYPES,
  SCHEMA_VERSION,
  type Archetype,
  type EntityKind,
  type LinkKind,
  type NodeRecord,
  type QualityTier,
  type TemporalPrecision,
  type Visibility,
  type WorldSettings,
} from './types.ts'

// Record and settings validation (PLAN § Data model). Pure: the caller passes `now`, so a
// result never depends on the wall clock at call time. Errors block a write; warnings are
// shown but do not. world.ts asserts the same rules when it builds the physics world.

export interface ValidationIssue {
  /** Dotted path into the record ('thermo.mass', 'links[2].targetId', 'anchorXZ'). */
  field: string
  message: string
  /** Stable machine code for the editor (e.g. 'sigma-snap', 'slug-taken'). */
  code?: string
}

/**
 * Outcome of the σ-spacing rule. 'snap': a free anchor exists within SNAP_MAX_DISTANCE and
 * is given in `anchorXZ`, so the editor can apply it and re-validate; 'reject': none does
 * (the user must move the node or change its date). Both are errors on 'anchorXZ'.
 */
export type SpacingOutcome =
  | { status: 'ok' }
  | { status: 'skipped' }
  | { status: 'snap'; anchorXZ: [number, number]; nearestId: string; distance: number }
  | { status: 'reject'; nearestId: string; distance: number }

export interface ValidationResult {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  spacing: SpacingOutcome
}

export interface ValidateNodeContext {
  settings: Pick<WorldSettings, 'T0'> & Partial<Pick<WorldSettings, 'yPerYear'>>
  /** Epoch ms used for the now + 5 y ceiling. */
  now: number
  /** The rest of the world (may include the record itself and trashed records). */
  others: readonly NodeRecord[]
  /** Links to a trashed target: an error per PLAN (default), or a warning so undo-able deletes do not lock edits. */
  trashedLinkTargets?: 'error' | 'warn'
}

export const TITLE_MAX = 200
export const SLUG_MAX = 80
/** A σ violation is snapped when a free spot lies within this distance; otherwise rejected. */
export const SNAP_MAX_DISTANCE = 2 * SIGMA
export const FUTURE_MS = FUTURE_YEARS * MS_PER_YEAR
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const PRECISIONS: readonly TemporalPrecision[] = ['year', 'month', 'day', 'minute']
const VISIBILITIES: readonly Visibility[] = ['private', 'public']
const ENTITY_KINDS: readonly EntityKind[] = ['person', 'place', 'organization', 'work', 'other']
const LINK_KINDS: readonly LinkKind[] = ['relates', 'supports', 'contradicts', 'derives', 'influenced-by']
const QUALITY_TIERS: readonly QualityTier[] = ['auto', 'high', 'medium', 'low']

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const oneOf = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T)

/** Earliest T0 that keeps the world span (T0 → now + 5 y) within MAX_SPAN_UNITS. */
export function minT0(now: number, yPerYear = Y_PER_YEAR): number {
  return now + FUTURE_MS - (MAX_SPAN_UNITS / yPerYear) * MS_PER_YEAR
}

/** Latest allowed temporalOrigin. */
export function maxTemporalOrigin(now: number): number {
  return now + FUTURE_MS
}

// ─── slugs ───────────────────────────────────────────────────────────────────────────

/** ASCII kebab-case base slug (diacritics folded; non-Latin scripts fall back to 'node'). */
export function slugBase(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX - 4)
    .replace(/-+$/g, '')
  return s || 'node'
}

/** Unique slug for `title`: the base, else base-2, base-3, … (first one not in existingSlugs). */
export function slugify(title: string, existingSlugs: Iterable<string> = []): string {
  const taken = existingSlugs instanceof Set ? (existingSlugs as ReadonlySet<string>) : new Set(existingSlugs)
  const base = slugBase(title)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`
    if (!taken.has(s)) return s
  }
}

// ─── drafts ──────────────────────────────────────────────────────────────────────────

/**
 * Per-archetype physics defaults. Memories are heavy and cold so splat-bearing tesseracts
 * stay put while you walk to them; ideas are light and volatile; entities are the heaviest
 * attractors; demons are cool so their sorting lattice reads as stable.
 */
export const ARCHETYPE_DEFAULTS: Readonly<Record<Archetype, { mass: number; temperature: number }>> = {
  memory: { mass: 2, temperature: 0.05 },
  idea: { mass: 1, temperature: 0.6 },
  entity: { mass: 3, temperature: 0.15 },
  lens: { mass: 1.5, temperature: 0.3 },
  document: { mass: 1, temperature: 0.25 },
  demon: { mass: 1, temperature: 0.2 },
}

export const DEFAULT_DEMON_RADIUS = 12

/**
 * A new, unsaved record with sensible defaults. `anchorXZ` is [0, 0] until placeAnchor runs;
 * the slug is derived from the title without uniqueness (call slugify with the world's slugs
 * before saving). Fields in `partial` win, except id/createdAt/updatedAt default fresh.
 */
export function makeNodeDraft(
  archetype: Archetype,
  partial: Partial<NodeRecord> = {},
  opts: { now?: number } = {},
): NodeRecord {
  const now = opts.now ?? Date.now()
  const d = ARCHETYPE_DEFAULTS[archetype]
  const title = partial.title ?? ''
  const draft: NodeRecord = {
    id: crypto.randomUUID(),
    slug: slugBase(title || archetype),
    archetype,
    title,
    contentMd: '',
    tags: [],
    temporalOrigin: now,
    temporalPrecision: 'day',
    referenceDate: null,
    thermo: { mass: d.mass, temperature: d.temperature },
    anchorXZ: [0, 0],
    links: [],
    attachments: [],
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
  }
  if (archetype === 'entity') draft.entity = { kind: 'other' }
  if (archetype === 'demon') draft.demon = { query: '', radius: DEFAULT_DEMON_RADIUS, active: true }
  const merged: NodeRecord = { ...draft, ...partial, archetype }
  if (partial.thermo) merged.thermo = { ...draft.thermo, ...partial.thermo }
  return merged
}

// ─── node validation ─────────────────────────────────────────────────────────────────

export function validateNode(record: NodeRecord, ctx: ValidateNodeContext): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const err = (field: string, message: string, code?: string) => errors.push({ field, message, code })
  const warn = (field: string, message: string, code?: string) => warnings.push({ field, message, code })
  const r = record as Partial<NodeRecord> & Record<string, unknown>
  let spacing: SpacingOutcome = { status: 'skipped' }

  if (r.schemaVersion !== SCHEMA_VERSION)
    err('schemaVersion', `schemaVersion must be ${SCHEMA_VERSION} (got ${String(r.schemaVersion)})`, 'schema-version')
  if (!isStr(r.id) || r.id.length === 0) err('id', 'id must be a non-empty string', 'id')
  if (!oneOf(ARCHETYPES, r.archetype)) err('archetype', `unknown archetype ${String(r.archetype)}`, 'archetype')

  // title
  if (!isStr(r.title)) err('title', 'title must be a string', 'title')
  else {
    const t = r.title.trim()
    if (t.length === 0) err('title', 'title must not be empty', 'title-empty')
    else if (t.length > TITLE_MAX) err('title', `title must be at most ${TITLE_MAX} characters`, 'title-long')
    if (t.length > 0 && t !== r.title) warn('title', 'title has leading or trailing whitespace', 'title-trim')
  }

  // slug
  if (!isStr(r.slug) || !SLUG_RE.test(r.slug) || r.slug.length > SLUG_MAX)
    err('slug', `slug must be lower-case kebab-case, at most ${SLUG_MAX} characters`, 'slug-format')
  else if (ctx.others.some((o) => o.id !== r.id && o.slug === r.slug))
    err('slug', `slug "${r.slug}" is already used`, 'slug-taken')

  if (!isStr(r.contentMd)) err('contentMd', 'contentMd must be a string', 'type')
  if (!Array.isArray(r.tags) || !r.tags.every(isStr)) err('tags', 'tags must be an array of strings', 'type')
  if (!oneOf(PRECISIONS, r.temporalPrecision)) err('temporalPrecision', 'unknown temporal precision', 'type')
  if (!oneOf(VISIBILITIES, r.visibility)) err('visibility', 'unknown visibility', 'type')
  if (!Array.isArray(r.attachments)) err('attachments', 'attachments must be an array', 'type')

  // time
  const { T0 } = ctx.settings
  const yPerYear = ctx.settings.yPerYear ?? Y_PER_YEAR
  const originOk = isNum(r.temporalOrigin)
  if (!originOk) err('temporalOrigin', 'temporalOrigin must be a finite epoch (ms)', 'type')
  else if (r.temporalOrigin! < T0) err('temporalOrigin', 'temporalOrigin is before the world start T0', 'before-t0')
  else if (r.temporalOrigin! > maxTemporalOrigin(ctx.now))
    err('temporalOrigin', `temporalOrigin is more than ${FUTURE_YEARS} years in the future`, 'too-far-future')

  // Display-only, so it may lie anywhere (before T0, centuries ago); only its shape is checked.
  if (r.referenceDate !== null && r.referenceDate !== undefined) {
    if (!isNum(r.referenceDate.epochMs)) err('referenceDate.epochMs', 'referenceDate must be a finite epoch (ms)', 'type')
    if (!oneOf(PRECISIONS, r.referenceDate.precision)) err('referenceDate.precision', 'unknown precision', 'type')
  } else if (r.referenceDate === undefined) err('referenceDate', 'referenceDate must be null or a date', 'type')

  // thermo
  const mass = r.thermo?.mass
  const temperature = r.thermo?.temperature
  if (!isNum(mass) || mass < MASS_RANGE[0] || mass > MASS_RANGE[1])
    err('thermo.mass', `mass must be in [${MASS_RANGE[0]}, ${MASS_RANGE[1]}]`, 'range')
  if (!isNum(temperature) || temperature < TEMPERATURE_RANGE[0] || temperature > TEMPERATURE_RANGE[1])
    err('thermo.temperature', `temperature must be in [${TEMPERATURE_RANGE[0]}, ${TEMPERATURE_RANGE[1]}]`, 'range')

  // anchor
  const a = r.anchorXZ
  const anchorOk = Array.isArray(a) && a.length === 2 && isNum(a[0]) && isNum(a[1])
  if (!anchorOk) err('anchorXZ', 'anchorXZ must be two finite numbers', 'type')
  else if (Math.hypot(a[0], a[1]) >= MAX_ANCHOR_RADIUS)
    err('anchorXZ', `anchor must lie within ${MAX_ANCHOR_RADIUS} u of the axis`, 'anchor-range')
  else if (originOk && r.deletedAt === null && isStr(r.id)) {
    spacing = checkSpacing(record, ctx, yPerYear)
    if (spacing.status === 'snap')
      err(
        'anchorXZ',
        `anchor is ${spacing.distance.toFixed(2)} u from ${spacing.nearestId} (< σ = ${SIGMA}); snap to (${spacing.anchorXZ[0]}, ${spacing.anchorXZ[1]})`,
        'sigma-snap',
      )
    else if (spacing.status === 'reject')
      err(
        'anchorXZ',
        `anchor is ${spacing.distance.toFixed(2)} u from ${spacing.nearestId} (< σ = ${SIGMA}) and no free spot lies within ${SNAP_MAX_DISTANCE} u`,
        'sigma-reject',
      )
  }

  // links
  if (!Array.isArray(r.links)) err('links', 'links must be an array', 'type')
  else {
    const byId = new Map(ctx.others.map((o) => [o.id, o]))
    const seen = new Set<string>()
    r.links.forEach((l, i) => {
      const f = `links[${i}]`
      if (!oneOf(LINK_KINDS, l?.kind)) err(`${f}.kind`, `unknown link kind ${String(l?.kind)}`, 'link-kind')
      if (!isStr(l?.targetId)) return err(`${f}.targetId`, 'targetId must be a string', 'type')
      if (l.targetId === r.id) err(`${f}.targetId`, 'a node cannot link to itself', 'link-self')
      else {
        const target = byId.get(l.targetId)
        if (!target) err(`${f}.targetId`, `link target ${l.targetId} does not exist`, 'link-missing')
        else if (target.deletedAt !== null) {
          const msg = `link target "${target.title}" is in the trash`
          if (ctx.trashedLinkTargets === 'warn') warn(`${f}.targetId`, msg, 'link-trashed')
          else err(`${f}.targetId`, msg, 'link-trashed')
        }
      }
      const key = `${l.targetId}\u0000${String(l.kind)}`
      if (seen.has(key)) err(f, `duplicate ${String(l.kind)} link to ${l.targetId}`, 'link-duplicate')
      seen.add(key)
    })
  }

  // per-archetype blocks
  if (r.archetype === 'entity') {
    if (!oneOf(ENTITY_KINDS, r.entity?.kind)) err('entity.kind', 'an entity needs entity.kind', 'entity-kind')
  } else if (r.entity !== undefined) warn('entity', `entity block is ignored on a ${String(r.archetype)}`, 'stray-block')
  if (r.archetype === 'demon') {
    const dm = r.demon
    if (!dm) err('demon', 'a demon needs a demon block', 'demon-block')
    else {
      if (!isNum(dm.radius) || dm.radius <= 0) err('demon.radius', 'demon radius must be > 0', 'demon-radius')
      if (!isStr(dm.query)) err('demon.query', 'demon query must be a string', 'type')
      else if (dm.query.trim() === '') warn('demon.query', 'an empty query matches nothing', 'demon-query-empty')
      if (typeof dm.active !== 'boolean') err('demon.active', 'demon.active must be a boolean', 'type')
    }
  } else if (r.demon !== undefined) warn('demon', `demon block is ignored on a ${String(r.archetype)}`, 'stray-block')
  if (r.splat !== undefined && r.archetype !== 'memory') err('splat', 'only memories may hold a splat diorama', 'splat-not-memory')

  // bookkeeping
  if (!isNum(r.createdAt)) err('createdAt', 'createdAt must be a finite epoch (ms)', 'type')
  if (!isNum(r.updatedAt)) err('updatedAt', 'updatedAt must be a finite epoch (ms)', 'type')
  else if (isNum(r.createdAt) && r.updatedAt < r.createdAt) warn('updatedAt', 'updatedAt precedes createdAt', 'clock')
  if (r.deletedAt !== null && !isNum(r.deletedAt)) err('deletedAt', 'deletedAt must be null or an epoch (ms)', 'type')

  return { ok: errors.length === 0, errors, warnings, spacing }
}

function checkSpacing(record: NodeRecord, ctx: ValidateNodeContext, yPerYear: number): SpacingOutcome {
  const opts = { T0: ctx.settings.T0, yPerYear }
  const existing = toPlacedAnchors(ctx.others, opts).filter((e) => e.id !== record.id)
  const y = yOf(record.temporalOrigin, opts.T0, yPerYear)
  const near = nearestAnchor(record.anchorXZ, y, existing, record.id)
  if (!near || near.distance >= SIGMA) return { status: 'ok' }
  const snapped = nudgeAnchor(record.anchorXZ, y, existing, {
    selfId: record.id,
    seed: fnv1a32(record.id),
    minRadius: oneOf(ARCHETYPES, record.archetype) ? minRadiusFor(record.archetype) : 0,
    maxDistance: SNAP_MAX_DISTANCE,
  })
  return snapped
    ? { status: 'snap', anchorXZ: snapped, nearestId: near.id, distance: near.distance }
    : { status: 'reject', nearestId: near.id, distance: near.distance }
}

/** Apply a 'sigma-snap' outcome (returns the record unchanged for any other outcome). */
export function applySnap(record: NodeRecord, result: ValidationResult): NodeRecord {
  return result.spacing.status === 'snap' ? { ...record, anchorXZ: result.spacing.anchorXZ } : record
}

// ─── settings validation ─────────────────────────────────────────────────────────────

export function validateSettings(s: WorldSettings, now: number): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const err = (field: string, message: string, code?: string) => errors.push({ field, message, code })
  const v = s as Partial<WorldSettings>

  if (v.schemaVersion !== SCHEMA_VERSION)
    err('schemaVersion', `schemaVersion must be ${SCHEMA_VERSION} (got ${String(v.schemaVersion)})`, 'schema-version')
  const yOk = isNum(v.yPerYear) && v.yPerYear > 0
  if (!yOk) err('yPerYear', 'yPerYear must be > 0', 'range')
  else if (v.yPerYear !== Y_PER_YEAR) warnings.push({ field: 'yPerYear', message: `non-standard yPerYear (default ${Y_PER_YEAR})`, code: 'nonstandard' })
  if (!Number.isInteger(v.stepsPerYear) || v.stepsPerYear! <= 0) err('stepsPerYear', 'stepsPerYear must be a positive integer', 'range')
  else if (v.stepsPerYear !== STEPS_PER_YEAR)
    warnings.push({ field: 'stepsPerYear', message: `non-standard stepsPerYear (default ${STEPS_PER_YEAR})`, code: 'nonstandard' })
  if (!Number.isInteger(v.physicsSeed) || v.physicsSeed! < 0 || v.physicsSeed! > 0xffff_ffff)
    err('physicsSeed', 'physicsSeed must be a uint32', 'range')
  if (!oneOf(QUALITY_TIERS, v.qualityTier)) err('qualityTier', 'unknown quality tier', 'type')
  if (typeof v.firstRunComplete !== 'boolean') err('firstRunComplete', 'firstRunComplete must be a boolean', 'type')
  if (typeof v.autoBackupEnabled !== 'boolean') err('autoBackupEnabled', 'autoBackupEnabled must be a boolean', 'type')
  if (v.lastBackupAt !== null && !isNum(v.lastBackupAt)) err('lastBackupAt', 'lastBackupAt must be null or an epoch (ms)', 'type')
  if (!isNum(v.createdAt)) err('createdAt', 'createdAt must be a finite epoch (ms)', 'type')

  if (!isNum(v.T0)) err('T0', 'T0 must be a finite epoch (ms)', 'type')
  else {
    if (v.T0 > now) err('T0', 'T0 (world start) cannot be in the future', 't0-future')
    if (yOk) {
      const spanUnits = yOf(maxTemporalOrigin(now), v.T0, v.yPerYear)
      if (spanUnits > MAX_SPAN_UNITS)
        err(
          'T0',
          `world span ${spanUnits.toFixed(0)} u exceeds ${MAX_SPAN_UNITS} u (T0 must be after ${new Date(minT0(now, v.yPerYear)).toISOString().slice(0, 10)})`,
          'span',
        )
    }
  }
  return { ok: errors.length === 0, errors, warnings, spacing: { status: 'skipped' } }
}
