import { describe, expect, it } from 'vitest'
import { MAX_ANCHOR_RADIUS, MS_PER_YEAR, SIGMA } from '../../src/domain/constants.ts'
import { placeAnchor, toPlacedAnchors } from '../../src/domain/placement.ts'
import { yOf } from '../../src/domain/time.ts'
import { ARCHETYPES, SCHEMA_VERSION, type NodeRecord, type WorldSettings } from '../../src/domain/types.ts'
import {
  ARCHETYPE_DEFAULTS,
  SLUG_MAX,
  applySnap,
  makeNodeDraft,
  maxTemporalOrigin,
  minT0,
  slugify,
  validateNode,
  validateSettings,
  type ValidateNodeContext,
} from '../../src/domain/validate.ts'

const NOW = Date.UTC(2026, 9, 14)
const T0 = Date.UTC(1990, 4, 17)
const settings: WorldSettings = {
  T0,
  yPerYear: 12,
  stepsPerYear: 600,
  physicsSeed: 12345,
  qualityTier: 'auto',
  firstRunComplete: true,
  lastBackupAt: null,
  autoBackupEnabled: false,
  createdAt: NOW,
  schemaVersion: SCHEMA_VERSION,
}

let seq = 0
function rec(partial: Partial<NodeRecord> = {}, others: NodeRecord[] = []): NodeRecord {
  const archetype = partial.archetype ?? 'idea'
  const title = partial.title ?? `Node ${++seq}`
  const r = makeNodeDraft(archetype, { temporalOrigin: Date.UTC(2010, 0, 1), ...partial, title }, { now: NOW })
  r.slug = partial.slug ?? slugify(title, others.map((o) => o.slug))
  if (!partial.anchorXZ) r.anchorXZ = placeAnchor(r, toPlacedAnchors(others, settings), settings)
  return r
}

const ctx = (others: NodeRecord[], extra: Partial<ValidateNodeContext> = {}): ValidateNodeContext => ({
  settings,
  now: NOW,
  others,
  ...extra,
})
const codes = (r: { errors: { code?: string }[] }) => r.errors.map((e) => e.code)

describe('slugify', () => {
  it('builds ascii kebab-case and dedupes', () => {
    expect(slugify('Boltzmann’s H-theorem (1872)')).toBe('boltzmanns-h-theorem-1872')
    expect(slugify('Café Müller')).toBe('cafe-muller')
    expect(slugify('Café', ['cafe', 'cafe-2'])).toBe('cafe-3')
    expect(slugify('Café', new Set(['cafe']))).toBe('cafe-2')
    expect(slugify('   ')).toBe('node')
    expect(slugify('東京')).toBe('node')
    const long = slugify('x'.repeat(500), ['x'.repeat(SLUG_MAX - 4)])
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX)
    expect(long.endsWith('-2')).toBe(true)
  })
})

describe('makeNodeDraft', () => {
  it('fills per-archetype defaults with a fresh uuid', () => {
    const a = makeNodeDraft('memory', {}, { now: NOW })
    const b = makeNodeDraft('memory', {}, { now: NOW })
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.thermo).toEqual({ mass: 2, temperature: 0.05 })
    expect(a.createdAt).toBe(NOW)
    expect(a.updatedAt).toBe(NOW)
    expect(a.deletedAt).toBeNull()
    expect(a.schemaVersion).toBe(SCHEMA_VERSION)
    expect(makeNodeDraft('idea').thermo.temperature).toBe(0.6)
    expect(makeNodeDraft('entity').thermo.mass).toBe(3)
    expect(makeNodeDraft('entity').entity).toEqual({ kind: 'other' })
    expect(makeNodeDraft('lens').thermo.mass).toBe(1.5)
    expect(makeNodeDraft('document').thermo.mass).toBe(1)
    expect(makeNodeDraft('demon').thermo.temperature).toBe(0.2)
    expect(makeNodeDraft('demon').demon!.radius).toBeGreaterThan(0)
  })

  it('lets the partial win and merges thermo', () => {
    const d = makeNodeDraft('idea', { title: 'Entropy', thermo: { mass: 2 } as NodeRecord['thermo'], tags: ['physics'] })
    expect(d.title).toBe('Entropy')
    expect(d.slug).toBe('entropy')
    expect(d.thermo).toEqual({ mass: 2, temperature: ARCHETYPE_DEFAULTS.idea.temperature })
    expect(d.tags).toEqual(['physics'])
  })

  it('produces records that validate once titled and placed', () => {
    const others: NodeRecord[] = []
    for (const archetype of ARCHETYPES) {
      const r = rec({ archetype }, others)
      const res = validateNode(r, ctx(others))
      const allowed = archetype === 'demon' ? ['demon-query-empty'] : []
      expect(res.errors).toEqual([])
      expect(res.warnings.map((w) => w.code).filter((c) => !allowed.includes(c!))).toEqual([])
      expect(res.spacing.status).toBe('ok')
      others.push(r)
    }
  })
})

describe('validateNode', () => {
  it('bounds temporalOrigin to [T0, now + 5 y]', () => {
    expect(validateNode(rec({ temporalOrigin: T0 }), ctx([])).ok).toBe(true)
    expect(codes(validateNode(rec({ temporalOrigin: T0 - 1 }), ctx([])))).toContain('before-t0')
    expect(validateNode(rec({ temporalOrigin: maxTemporalOrigin(NOW) }), ctx([])).ok).toBe(true)
    expect(codes(validateNode(rec({ temporalOrigin: maxTemporalOrigin(NOW) + 1 }), ctx([])))).toContain('too-far-future')
    expect(codes(validateNode(rec({ temporalOrigin: NaN, anchorXZ: [30, 0] }), ctx([])))).toContain('type')
  })

  it('allows a referenceDate anywhere (display only)', () => {
    const r = rec({ referenceDate: { epochMs: Date.UTC(1877, 0, 1), precision: 'year', label: 'Boltzmann' } })
    expect(validateNode(r, ctx([])).ok).toBe(true)
  })

  it('rejects anchors at or beyond the world radius', () => {
    expect(codes(validateNode(rec({ anchorXZ: [MAX_ANCHOR_RADIUS, 0] }), ctx([])))).toContain('anchor-range')
    expect(codes(validateNode(rec({ anchorXZ: [2000, 2300] }), ctx([])))).toContain('anchor-range')
    expect(validateNode(rec({ anchorXZ: [2000, 2000] }), ctx([])).ok).toBe(true)
    expect(codes(validateNode(rec({ anchorXZ: [Infinity, 0] }), ctx([])))).toContain('type')
  })

  it('snaps an anchor that is closer than σ when a free spot is near', () => {
    const a = rec({ anchorXZ: [30, 0] })
    const b = rec({ anchorXZ: [31, 0.5], temporalOrigin: a.temporalOrigin })
    const res = validateNode(b, ctx([a]))
    expect(res.ok).toBe(false)
    expect(codes(res)).toEqual(['sigma-snap'])
    expect(res.spacing.status).toBe('snap')
    const fixed = applySnap(b, res)
    expect(Math.hypot(fixed.anchorXZ[0] - 30, fixed.anchorXZ[1])).toBeGreaterThanOrEqual(SIGMA)
    expect(validateNode(fixed, ctx([a])).ok).toBe(true)
  })

  it('rejects when no free spot lies within the snap distance', () => {
    const t = Date.UTC(2010, 0, 1)
    const crowd: NodeRecord[] = []
    for (let i = -10; i <= 10; i++)
      for (let j = -10; j <= 10; j++) crowd.push(rec({ anchorXZ: [100 + 2 * i, 2 * j], temporalOrigin: t, slug: `c-${i}-${j}` }))
    const r = rec({ anchorXZ: [100.5, 0.5], temporalOrigin: t })
    const res = validateNode(r, ctx(crowd))
    expect(codes(res)).toEqual(['sigma-reject'])
    expect(res.spacing.status).toBe('reject')
    expect(applySnap(r, res)).toBe(r)
  })

  it('measures σ in 3D (Y = time) and ignores the trash and the record itself', () => {
    const a = rec({ anchorXZ: [30, 0], temporalOrigin: Date.UTC(2010, 0, 1) })
    const later = Date.UTC(2010, 0, 1) + (SIGMA / 12 + 0.01) * MS_PER_YEAR
    expect(yOf(later, T0) - yOf(a.temporalOrigin, T0)).toBeGreaterThan(SIGMA)
    expect(validateNode(rec({ anchorXZ: [30, 0], temporalOrigin: later }), ctx([a])).ok).toBe(true)
    const trashed = { ...a, deletedAt: NOW }
    expect(validateNode(rec({ anchorXZ: [30, 0], temporalOrigin: a.temporalOrigin }), ctx([trashed])).ok).toBe(true)
    expect(validateNode(a, ctx([a])).ok).toBe(true)
  })

  it('checks thermo ranges', () => {
    const bad = (mass: number, temperature: number) => codes(validateNode(rec({ thermo: { mass, temperature } }), ctx([])))
    expect(bad(0.25, 0)).toEqual([])
    expect(bad(4, 1)).toEqual([])
    expect(bad(0.24, 0.5)).toEqual(['range'])
    expect(bad(4.01, 0.5)).toEqual(['range'])
    expect(bad(1, -0.01)).toEqual(['range'])
    expect(bad(1, 1.01)).toEqual(['range'])
    expect(bad(NaN, NaN)).toEqual(['range', 'range'])
  })

  it('checks the title', () => {
    expect(codes(validateNode(rec({ title: '   ', slug: 'blank' }), ctx([])))).toContain('title-empty')
    expect(codes(validateNode(rec({ title: 'x'.repeat(201), slug: 'long' }), ctx([])))).toContain('title-long')
    expect(validateNode(rec({ title: 'x'.repeat(200), slug: 'ok' }), ctx([])).ok).toBe(true)
    const padded = validateNode(rec({ title: ' Padded ', slug: 'padded' }), ctx([]))
    expect(padded.ok).toBe(true)
    expect(padded.warnings.map((w) => w.code)).toEqual(['title-trim'])
  })

  it('requires a well-formed, unique slug', () => {
    const a = rec({ title: 'Entropy' })
    expect(codes(validateNode(rec({ slug: 'entropy' }), ctx([a])))).toEqual(['slug-taken'])
    expect(validateNode(a, ctx([a])).ok).toBe(true)
    expect(codes(validateNode(rec({ slug: 'Not A Slug' }), ctx([])))).toEqual(['slug-format'])
    expect(codes(validateNode(rec({ slug: '' }), ctx([])))).toEqual(['slug-format'])
    // A trashed record still owns its slug (restoring it must not collide).
    expect(codes(validateNode(rec({ slug: 'entropy' }), ctx([{ ...a, deletedAt: NOW }])))).toEqual(['slug-taken'])
  })

  it('checks links', () => {
    const a = rec()
    const gone = { ...rec(), deletedAt: NOW }
    const others = [a, gone]
    const link = (targetId: string, kind: NodeRecord['links'][number]['kind'] = 'relates') => ({ targetId, kind, createdAt: NOW })
    const self = rec({ id: 'me', links: [link('me')] }, others)
    expect(codes(validateNode(self, ctx(others)))).toEqual(['link-self'])
    expect(codes(validateNode(rec({ links: [link('nope')] }, others), ctx(others)))).toEqual(['link-missing'])
    expect(codes(validateNode(rec({ links: [link(gone.id)] }, others), ctx(others)))).toEqual(['link-trashed'])
    const warned = validateNode(rec({ links: [link(gone.id)] }, others), ctx(others, { trashedLinkTargets: 'warn' }))
    expect(warned.ok).toBe(true)
    expect(warned.warnings.map((w) => w.code)).toEqual(['link-trashed'])
    expect(codes(validateNode(rec({ links: [link(a.id), link(a.id)] }, others), ctx(others)))).toEqual(['link-duplicate'])
    expect(validateNode(rec({ links: [link(a.id), link(a.id, 'supports')] }, others), ctx(others)).ok).toBe(true)
    const badKind = rec({ links: [{ targetId: a.id, kind: 'hates' as never, createdAt: NOW }] }, others)
    expect(codes(validateNode(badKind, ctx(others)))).toEqual(['link-kind'])
  })

  it('checks per-archetype blocks', () => {
    const entity = rec({ archetype: 'entity' })
    delete entity.entity
    expect(codes(validateNode(entity, ctx([])))).toEqual(['entity-kind'])
    const demon = rec({ archetype: 'demon' })
    delete demon.demon
    expect(codes(validateNode(demon, ctx([])))).toEqual(['demon-block'])
    const flat = rec({ archetype: 'demon', demon: { query: 'entropy', radius: 0, active: true } })
    expect(codes(validateNode(flat, ctx([])))).toEqual(['demon-radius'])
    const splat = {
      proxyAssetId: null,
      interiorAssetId: null,
      thumbAssetId: null,
      entryPose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      crop: null,
      upFix: [0, 0, 0, 1],
      counts: { interior: 0, proxy: 0 },
      sourceFormat: 'spz',
    } satisfies NodeRecord['splat']
    expect(codes(validateNode(rec({ archetype: 'idea', splat }), ctx([])))).toEqual(['splat-not-memory'])
    expect(validateNode(rec({ archetype: 'memory', splat }), ctx([])).ok).toBe(true)
    const stray = validateNode(rec({ archetype: 'idea', entity: { kind: 'person' } }), ctx([]))
    expect(stray.ok).toBe(true)
    expect(stray.warnings.map((w) => w.code)).toEqual(['stray-block'])
  })

  it('requires the current schema version', () => {
    expect(codes(validateNode(rec({ schemaVersion: SCHEMA_VERSION + 1 }), ctx([])))).toEqual(['schema-version'])
  })
})

describe('validateSettings', () => {
  it('accepts sane settings', () => {
    const r = validateSettings(settings, NOW)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('caps the world span at 3000 u (T0 ≥ now − 245 y)', () => {
    const edge = minT0(NOW)
    expect((NOW - edge) / MS_PER_YEAR).toBeCloseTo(245, 6)
    expect(validateSettings({ ...settings, T0: edge }, NOW).ok).toBe(true)
    expect(validateSettings({ ...settings, T0: edge - 86_400_000 }, NOW).errors.map((e) => e.code)).toEqual(['span'])
    // A denser time axis shortens the allowed span.
    expect(validateSettings({ ...settings, T0: NOW - 200 * MS_PER_YEAR, yPerYear: 24 }, NOW).errors.map((e) => e.code)).toEqual(['span'])
  })

  it('rejects a future T0 and malformed fields', () => {
    expect(validateSettings({ ...settings, T0: NOW + 1 }, NOW).errors.map((e) => e.code)).toEqual(['t0-future'])
    expect(validateSettings({ ...settings, yPerYear: 0 }, NOW).errors.map((e) => e.field)).toEqual(['yPerYear'])
    expect(validateSettings({ ...settings, stepsPerYear: 1.5 }, NOW).errors.map((e) => e.field)).toEqual(['stepsPerYear'])
    expect(validateSettings({ ...settings, physicsSeed: -1 }, NOW).errors.map((e) => e.field)).toEqual(['physicsSeed'])
    expect(validateSettings({ ...settings, qualityTier: 'ultra' as never }, NOW).errors.map((e) => e.field)).toEqual(['qualityTier'])
    expect(validateSettings({ ...settings, schemaVersion: 0 }, NOW).errors.map((e) => e.field)).toEqual(['schemaVersion'])
    expect(validateSettings({ ...settings, stepsPerYear: 1200 }, NOW).warnings.map((e) => e.field)).toEqual(['stepsPerYear'])
  })
})
