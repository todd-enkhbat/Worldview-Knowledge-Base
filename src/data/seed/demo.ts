import { MS_PER_YEAR } from '../../domain/constants.ts'
import { placeAnchor } from '../../domain/placement.ts'
import type { PlacedAnchor } from '../../domain/placement.ts'
import { truncateToPrecision, yOf } from '../../domain/time.ts'
import { SCHEMA_VERSION } from '../../domain/types.ts'
import type {
  Archetype,
  DemonBlock,
  EntityKind,
  LinkKind,
  NodeRecord,
  ReferenceDate,
  TemporalPrecision,
} from '../../domain/types.ts'
import { slugify } from '../../domain/validate.ts'

// Optional demo worldview offered at first run: a life that met thermodynamics through
// Maxwell's demon and followed it into information theory and the arrow of time.
// temporalOrigin is biographical (when the idea entered this person's life, as years
// after T0); referenceDate carries the historical date and never affects layout.
// Output is a pure function of (T0, now): ids are uuid-shaped hashes of (T0, key) and
// anchors are placed with placeAnchor in list order, so recordHashes are reproducible.

/** A person's T0 is usually their birth; the demo story spans roughly ages 7 to 29. */
interface DemoSpec {
  key: string
  archetype: Archetype
  title: string
  contentMd: string
  tags: string[]
  /** Years after T0, or (when `future`) years after now. */
  at: number
  future?: boolean
  precision: TemporalPrecision
  ref?: { y: number; m?: number; d?: number; label?: string }
  mass: number
  temperature: number
  entity?: EntityKind
  demon?: Omit<DemonBlock, 'active'>
  links?: { to: string; kind: LinkKind; label?: string }[]
}

const SPECS: readonly DemoSpec[] = [
  // ── memories: lived moments (cold, so a later diorama stays still) ──────────────────
  {
    key: 'memory-ink',
    archetype: 'memory',
    title: 'Ink blooming in a glass of water',
    contentMd:
      'A drop of fountain-pen ink unfolding through a glass of water and never folding back. The first time I noticed that some things only run one way.',
    tags: ['time', 'entropy', 'childhood'],
    at: 7.4,
    precision: 'day',
    mass: 1.6,
    temperature: 0.04,
  },
  {
    key: 'memory-clock',
    archetype: 'memory',
    title: "Grandmother's kitchen clock",
    contentMd:
      'Wound every Sunday, run down by Saturday. Keeping order took work, and somebody had to do it every week.',
    tags: ['time', 'memory', 'home'],
    at: 9.1,
    precision: 'day',
    mass: 1.4,
    temperature: 0.04,
  },
  // ── the teacher and the demon ─────────────────────────────────────────────────────────
  {
    key: 'entity-teacher',
    archetype: 'entity',
    title: 'The teacher who drew the demon',
    contentMd:
      'My physics teacher sketched a tiny doorkeeper between two boxes of gas and asked why it could not work. Nobody in the room had a good answer, including, she admitted, her.',
    tags: ['thermodynamics', 'teaching', 'mentor'],
    at: 15.2,
    precision: 'month',
    mass: 2.6,
    temperature: 0.12,
    entity: 'person',
    links: [{ to: 'idea-demon', kind: 'relates', label: 'drew it on the board' }],
  },
  {
    key: 'idea-demon',
    archetype: 'idea',
    title: "Maxwell's demon",
    contentMd:
      'A being that lets fast molecules through a door one way and slow ones the other seems to build a temperature difference without doing work. Settling why it fails took about a century.',
    tags: ['thermodynamics', 'information', 'demon'],
    at: 15.3,
    precision: 'month',
    ref: { y: 1867, m: 12, label: 'Letter to P. G. Tait' },
    mass: 3,
    temperature: 0.5,
    links: [{ to: 'entity-maxwell', kind: 'influenced-by' }],
  },
  {
    key: 'entity-maxwell',
    archetype: 'entity',
    title: 'James Clerk Maxwell',
    contentMd:
      "Unified electricity, magnetism and light, gave the velocity distribution of a gas, and invented the 'finite being' that sorts molecules for free.",
    tags: ['thermodynamics', 'history', 'electromagnetism'],
    at: 16,
    precision: 'month',
    ref: { y: 1831, m: 6, d: 13, label: 'Born, Edinburgh' },
    mass: 3.2,
    temperature: 0.18,
    entity: 'person',
  },
  {
    key: 'lens-thermo',
    archetype: 'lens',
    title: 'Thermodynamics',
    contentMd:
      'Energy is conserved, entropy does not decrease, and every engine pays a tax to its cold reservoir. I apply it to almost everything, including things it was never built for.',
    tags: ['thermodynamics', 'entropy', 'lens'],
    at: 17,
    precision: 'month',
    mass: 3.4,
    temperature: 0.22,
  },
  {
    key: 'doc-ratchet',
    archetype: 'document',
    title: 'Ratchet and pawl (Feynman Lectures I-46)',
    contentMd:
      'Notes on why a Brownian ratchet at one uniform temperature cannot turn one way on average. Only a temperature difference makes it go.',
    tags: ['thermodynamics', 'reading', 'notes'],
    at: 18.2,
    precision: 'month',
    ref: { y: 1963, label: 'The Feynman Lectures on Physics, vol. I' },
    mass: 1.2,
    temperature: 0.3,
  },
  {
    key: 'memory-library',
    archetype: 'memory',
    title: 'The physics stacks after closing',
    contentMd:
      "Reading Boltzmann's lectures in a library that smelled of dust and radiator heat, long after I should have gone home.",
    tags: ['thermodynamics', 'reading', 'memory'],
    at: 18.6,
    precision: 'day',
    mass: 1.2,
    temperature: 0.04,
  },
  // ── Boltzmann and the reversibility objections ──────────────────────────────────────
  {
    key: 'entity-boltzmann',
    archetype: 'entity',
    title: 'Ludwig Boltzmann',
    contentMd:
      'Held that atoms are real and that entropy counts microstates. Spent much of his career defending statistical mechanics against colleagues who doubted atoms existed.',
    tags: ['entropy', 'history', 'thermodynamics'],
    at: 19,
    precision: 'month',
    ref: { y: 1844, m: 2, d: 20, label: 'Born, Vienna' },
    mass: 3.6,
    temperature: 0.18,
    entity: 'person',
  },
  {
    key: 'idea-h-theorem',
    archetype: 'idea',
    title: "Boltzmann's H-theorem",
    contentMd:
      'From a collision equation, a quantity H can only decrease, so a dilute gas relaxes to equilibrium. The first attempt to derive irreversibility from mechanics.',
    tags: ['entropy', 'time', 'thermodynamics'],
    at: 19.4,
    precision: 'month',
    ref: { y: 1872 },
    mass: 2.6,
    temperature: 0.4,
    links: [{ to: 'entity-boltzmann', kind: 'derives' }],
  },
  {
    key: 'idea-loschmidt',
    archetype: 'idea',
    title: "Loschmidt's reversibility paradox",
    contentMd:
      'Reverse every velocity and the molecules retrace their paths while entropy goes down. So irreversibility cannot come from the dynamics alone.',
    tags: ['time', 'entropy', 'symmetry'],
    at: 19.9,
    precision: 'month',
    ref: { y: 1876 },
    mass: 2.2,
    temperature: 0.55,
    links: [{ to: 'idea-h-theorem', kind: 'contradicts' }],
  },
  {
    key: 'idea-noether',
    archetype: 'idea',
    title: "Noether's theorem",
    contentMd:
      'Every continuous symmetry of the action gives a conserved quantity. Symmetry under shifts in time gives conservation of energy.',
    tags: ['symmetry', 'dynamics'],
    at: 20.6,
    precision: 'month',
    ref: { y: 1918 },
    mass: 2.8,
    temperature: 0.35,
  },
  {
    key: 'idea-poincare',
    archetype: 'idea',
    title: 'Poincaré recurrence',
    contentMd:
      "A bounded mechanical system returns arbitrarily close to where it started, given enough time. For a room of gas, 'enough' is absurdly long.",
    tags: ['time', 'dynamics', 'symmetry'],
    at: 21,
    precision: 'month',
    ref: { y: 1890 },
    mass: 1.8,
    temperature: 0.6,
  },
  // ── information ─────────────────────────────────────────────────────────────────────
  {
    key: 'lens-information',
    archetype: 'lens',
    title: 'Information theory',
    contentMd:
      'Messages as choices among possibilities, measured in bits. It explains why keeping a record of the past has a cost.',
    tags: ['information', 'entropy', 'lens'],
    at: 22,
    precision: 'month',
    mass: 3,
    temperature: 0.28,
  },
  {
    key: 'idea-shannon',
    archetype: 'idea',
    title: 'Shannon entropy',
    contentMd:
      "H = −Σ p log p, the average surprise of a source. It has the same form as Gibbs' entropy, and that is not a coincidence.",
    tags: ['information', 'entropy'],
    at: 22.1,
    precision: 'month',
    ref: { y: 1948 },
    mass: 3,
    temperature: 0.4,
    links: [{ to: 'idea-h-theorem', kind: 'influenced-by', label: 'same functional form' }],
  },
  {
    key: 'idea-szilard',
    archetype: 'idea',
    title: "Szilard's one-molecule engine",
    contentMd:
      'One molecule, a box, a partition and a measurement. Knowing which side the molecule is on is worth kT ln 2 of work.',
    tags: ['information', 'thermodynamics', 'demon'],
    at: 22.6,
    precision: 'month',
    ref: { y: 1929 },
    mass: 1.6,
    temperature: 0.5,
  },
  {
    key: 'idea-landauer',
    archetype: 'idea',
    title: "Landauer's principle",
    contentMd: 'Erasing one bit dissipates at least kT ln 2 of heat. Information is physical.',
    tags: ['information', 'thermodynamics', 'demon'],
    at: 23.1,
    precision: 'month',
    ref: { y: 1961 },
    mass: 2.8,
    temperature: 0.45,
    links: [{ to: 'idea-szilard', kind: 'derives' }],
  },
  {
    key: 'idea-bennett',
    archetype: 'idea',
    title: "Bennett's exorcism of the demon",
    contentMd:
      "Measurement can be made reversible; the unavoidable cost is erasing the demon's memory. The demon fails because it cannot forget for free.",
    tags: ['information', 'demon', 'memory'],
    at: 23.8,
    precision: 'month',
    ref: { y: 1982 },
    mass: 2.4,
    temperature: 0.45,
    links: [
      { to: 'idea-landauer', kind: 'derives' },
      { to: 'idea-demon', kind: 'contradicts', label: 'exorcism' },
    ],
  },
  {
    key: 'doc-ledger',
    archetype: 'document',
    title: "Notebook: the demon's ledger",
    contentMd:
      'Working notes that tally what a demon must remember for each sorted molecule, and what it costs to wipe that memory clean.',
    tags: ['demon', 'information', 'notes'],
    at: 24,
    precision: 'month',
    mass: 1,
    temperature: 0.35,
  },
  {
    key: 'memory-train',
    archetype: 'memory',
    title: 'Night train over the Brenner Pass',
    contentMd:
      'Frost growing on the window while the carriage warmed. A whole afternoon of sunlight, slowly spent.',
    tags: ['phenomenology', 'travel', 'time'],
    at: 24.2,
    precision: 'day',
    mass: 1,
    temperature: 0.04,
  },
  // ── the arrow of time ───────────────────────────────────────────────────────────────
  {
    key: 'idea-past-hypothesis',
    archetype: 'idea',
    title: 'The Past Hypothesis',
    contentMd:
      'The arrow of time comes from an extraordinarily low-entropy beginning, not from the laws. Every record and every memory points back toward it.',
    tags: ['time', 'entropy', 'cosmology'],
    at: 25,
    precision: 'month',
    ref: { y: 1979, label: 'Penrose 1979; The Emperor’s New Mind, 1989' },
    mass: 3.2,
    temperature: 0.3,
    links: [{ to: 'idea-h-theorem', kind: 'supports', label: 'why H falls toward the future' }],
  },
  {
    key: 'idea-dissipative',
    archetype: 'idea',
    title: 'Dissipative structures',
    contentMd:
      'Open systems far from equilibrium can build order by exporting entropy: convection cells, chemical clocks, cities.',
    tags: ['thermodynamics', 'complexity'],
    at: 25.9,
    precision: 'month',
    ref: { y: 1977, label: 'Prigogine, Nobel Prize in Chemistry' },
    mass: 2,
    temperature: 0.65,
  },
  {
    key: 'entity-vienna',
    archetype: 'entity',
    title: 'Vienna',
    contentMd:
      'The city of Boltzmann, Mach and the Vienna Circle, where arguments about what is real were held in coffeehouses.',
    tags: ['vienna', 'history', 'place'],
    at: 26.7,
    precision: 'month',
    mass: 2,
    temperature: 0.1,
    entity: 'place',
  },
  {
    key: 'memory-grave',
    archetype: 'memory',
    title: 'S = k log W on a headstone',
    contentMd:
      "Standing at Boltzmann's grave in Vienna's Zentralfriedhof, where the entropy formula is carved above his bust.",
    tags: ['entropy', 'vienna', 'memory'],
    at: 26.8,
    precision: 'day',
    mass: 1.8,
    temperature: 0.04,
    links: [
      { to: 'entity-boltzmann', kind: 'relates' },
      { to: 'entity-vienna', kind: 'relates' },
    ],
  },
  // ── experience ──────────────────────────────────────────────────────────────────────
  {
    key: 'lens-phenomenology',
    archetype: 'lens',
    title: 'Phenomenology',
    contentMd:
      'Start from how things show up in experience before theorising about them. Time is first lived, as a now with a fading tail and a leading edge, and only later measured.',
    tags: ['phenomenology', 'mind', 'lens'],
    at: 27.2,
    precision: 'month',
    mass: 2.4,
    temperature: 0.32,
  },
  {
    key: 'idea-retention',
    archetype: 'idea',
    title: 'Retention and protention',
    contentMd:
      'Husserl: the present is never a point. It holds the just-past and leans into the about-to-be, which is why a melody is heard as a whole.',
    tags: ['phenomenology', 'time', 'memory'],
    at: 27.5,
    precision: 'month',
    ref: { y: 1905, label: 'Lectures on internal time-consciousness' },
    mass: 1.6,
    temperature: 0.55,
  },
  {
    key: 'idea-memory-arrow',
    archetype: 'idea',
    title: 'Why do we remember the past and not the future?',
    contentMd:
      'A memory is a record, and records form only in the direction entropy increases. Open question: is that the whole story of experienced time?',
    tags: ['memory', 'time', 'entropy'],
    at: 28,
    precision: 'month',
    mass: 1.4,
    temperature: 0.8,
    links: [{ to: 'idea-past-hypothesis', kind: 'relates' }],
  },
  {
    key: 'doc-essay',
    archetype: 'document',
    title: 'Draft essay: memory points to the past',
    contentMd:
      "An unfinished essay that tries to join the Past Hypothesis, Landauer's principle and Husserl's retention into one account of why time feels directed.",
    tags: ['memory', 'time', 'phenomenology'],
    at: 28.3,
    precision: 'month',
    mass: 1.2,
    temperature: 0.5,
    links: [
      { to: 'idea-retention', kind: 'derives' },
      { to: 'idea-past-hypothesis', kind: 'derives' },
    ],
  },
  // ── demons: standing queries that sort matching nodes ──────────────────────────────
  {
    key: 'demon-entropy',
    archetype: 'demon',
    title: 'Entropy',
    contentMd: 'Gathers everything about irreversibility and keeps a log of what it sorts.',
    tags: ['entropy', 'demon'],
    at: 28.6,
    precision: 'month',
    mass: 1.5,
    temperature: 0.2,
    demon: { query: 'entropy irreversibility arrow time thermodynamics second law', radius: 36 },
  },
  {
    key: 'demon-memory',
    archetype: 'demon',
    title: 'Memory',
    contentMd: 'Gathers records, retention and remembering: anything that keeps the past.',
    tags: ['memory', 'demon'],
    at: 28.7,
    precision: 'month',
    mass: 1.5,
    temperature: 0.2,
    demon: { query: 'memory record remember past retention erase', radius: 30 },
  },
  // ── plans (future, ≤ now + 5 y) ─────────────────────────────────────────────────────
  {
    key: 'plan-automaton',
    archetype: 'idea',
    title: 'Build a reversible cellular automaton',
    contentMd:
      'Plan: a small Margolus-neighbourhood gas that runs backward exactly, to watch entropy rise and then fall on command.',
    tags: ['information', 'dynamics', 'plan'],
    at: 1.3,
    future: true,
    precision: 'month',
    mass: 0.8,
    temperature: 0.7,
    links: [{ to: 'idea-poincare', kind: 'relates' }],
  },
  {
    key: 'plan-gas-theory',
    archetype: 'document',
    title: "Read Boltzmann's Lectures on Gas Theory in full",
    contentMd: 'Plan: both volumes, slowly, with notes kept in this world.',
    tags: ['thermodynamics', 'reading', 'plan'],
    at: 3.5,
    future: true,
    precision: 'month',
    ref: { y: 1896, label: 'Vorlesungen über Gastheorie, vol. I' },
    mass: 1,
    temperature: 0.3,
  },
]

export const DEMO_SIZE = SPECS.length

// ─── deterministic ids ───────────────────────────────────────────────────────────────

function hash32(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // murmur3 finaliser, so nearby keys spread over all 32 bits
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** uuid-v4-shaped id derived from a key; stable across runs and machines. */
export function seededUuid(key: string): string {
  const hex = [1, 2, 3, 4].map((k) => hash32(key, Math.imul(0x9e3779b9, k)).toString(16).padStart(8, '0')).join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function demoId(T0: number, key: string): string {
  return seededUuid(`wv-demo:${T0}:${key}`)
}

// ─── dates ───────────────────────────────────────────────────────────────────────────

function refDate(ref: NonNullable<DemoSpec['ref']>): ReferenceDate {
  const precision: TemporalPrecision = ref.d !== undefined ? 'day' : ref.m !== undefined ? 'month' : 'year'
  const out: ReferenceDate = { epochMs: Date.UTC(ref.y, (ref.m ?? 1) - 1, ref.d ?? 1), precision }
  if (ref.label) out.label = ref.label
  return out
}

/**
 * Ages are written for a T0 that is a birth date. When the world is younger than the story
 * (a recent "worldview start"), past items are compressed into the available span instead
 * of piling up at `now`, keeping their order.
 */
function pastScale(T0: number, now: number): number {
  const spanYears = (now - T0) / MS_PER_YEAR
  const latest = Math.max(...SPECS.filter((s) => !s.future).map((s) => s.at))
  const usable = spanYears * 0.98
  return usable > 0 && usable < latest ? usable / latest : 1
}

function originFor(spec: DemoSpec, T0: number, now: number, scale: number): number {
  const raw = spec.future ? now + spec.at * MS_PER_YEAR : T0 + spec.at * scale * MS_PER_YEAR
  const truncated = truncateToPrecision(raw, spec.precision)
  const upper = spec.future ? now + 5 * MS_PER_YEAR : now
  return Math.max(T0, Math.min(upper, truncated))
}

// ─── build ───────────────────────────────────────────────────────────────────────────

export interface BuildDemoOptions {
  /** Anchors already in the world (seeding into a non-empty world). */
  existing?: readonly PlacedAnchor[]
  /** Slugs already taken. */
  existingSlugs?: Iterable<string>
  yPerYear?: number
}

/**
 * ~30 demo records spanning all six archetypes. Pure in (T0, now, options): ids, dates,
 * slugs, links and anchors are all deterministic.
 */
export function buildDemoWorld(T0: number, now: number, opts: BuildDemoOptions = {}): NodeRecord[] {
  const scale = pastScale(T0, now)
  const ids = new Map(SPECS.map((s) => [s.key, demoId(T0, s.key)]))
  const slugs = new Set<string>(opts.existingSlugs ?? [])
  const placed: PlacedAnchor[] = [...(opts.existing ?? [])]
  const out: NodeRecord[] = []

  SPECS.forEach((spec, i) => {
    // createdAt follows list order and stays ≤ now.
    const createdAt = now - (SPECS.length - 1 - i)
    const temporalOrigin = originFor(spec, T0, now, scale)
    const record: NodeRecord = {
      id: ids.get(spec.key)!,
      slug: '',
      archetype: spec.archetype,
      title: spec.title,
      contentMd: spec.contentMd,
      tags: [...spec.tags],
      temporalOrigin,
      temporalPrecision: spec.precision,
      referenceDate: spec.ref ? refDate(spec.ref) : null,
      thermo: { mass: spec.mass, temperature: spec.temperature },
      anchorXZ: [0, 0],
      links: (spec.links ?? []).map((l) => {
        const link: NodeRecord['links'][number] = { targetId: ids.get(l.to)!, kind: l.kind, createdAt }
        if (l.label) link.label = l.label
        return link
      }),
      attachments: [],
      visibility: 'private',
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
    }
    if (spec.entity) record.entity = { kind: spec.entity }
    if (spec.demon) record.demon = { ...spec.demon, active: true }

    record.slug = slugify(record.title, slugs)
    slugs.add(record.slug)

    const y = yOf(temporalOrigin, T0, opts.yPerYear)
    record.anchorXZ = placeAnchor(record, placed, { T0, yPerYear: opts.yPerYear })
    placed.push({ id: record.id, anchorXZ: record.anchorXZ, y })
    out.push(record)
  })

  return out
}
