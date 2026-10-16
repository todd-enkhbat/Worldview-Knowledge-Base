import { z } from 'zod'
import { ARCHETYPES } from '../domain/types.ts'

// The omnibox refinement contract, shared by the browser (src/ai/omnibox.ts) and the server
// (server/refine.ts). The model answers with REFINE_JSON_SCHEMA (structured outputs); the
// reply is then checked again with RefineOutput.safeParse, because a schema-valid reply can
// still name an unknown link target or an impossible date, and the server must never trust
// what it relays.

const PRECISION = ['year', 'month', 'day'] as const
const ENTITY_KINDS = ['person', 'place', 'organization', 'work', 'other'] as const
const LINK_KINDS = ['relates', 'supports', 'contradicts', 'derives', 'influenced-by'] as const

export const RefineCandidate = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200),
  archetype: z.enum(ARCHETYPES as unknown as [string, ...string[]]),
})

export const RefineInput = z.object({
  text: z.string().trim().min(1).max(4000),
  /** Today's date (YYYY-MM-DD), so "last summer" resolves. */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The world's T0 (YYYY-MM-DD): nothing may be dated before it. */
  t0: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Nearest existing nodes (semantic neighbours, else recent ones); the only valid link targets. */
  candidates: z.array(RefineCandidate).max(16),
})
export type RefineInput = z.infer<typeof RefineInput>

const IsoPartial = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)

export const RefineOutput = z.object({
  archetype: z.enum(ARCHETYPES as unknown as [string, ...string[]]),
  title: z.string().trim().min(1).max(120),
  contentMd: z.string().max(8000),
  tags: z.array(z.string().trim().min(1).max(40)).max(6),
  date: z.object({ iso: IsoPartial, precision: z.enum(PRECISION) }),
  referenceDate: z.object({ iso: IsoPartial, precision: z.enum(PRECISION), label: z.string().max(80) }).nullable(),
  entityKind: z.enum(ENTITY_KINDS).nullable(),
  demonQuery: z.string().max(200).nullable(),
  mass: z.number(),
  temperature: z.number(),
  links: z.array(z.object({ targetId: z.string(), kind: z.enum(LINK_KINDS), label: z.string().max(80).nullable() })).max(8),
})
export type RefineOutput = z.infer<typeof RefineOutput>

export type RefineResult =
  | { ok: true; output: RefineOutput; model: string }
  | { ok: false; reason: 'refusal' | 'invalid' | 'truncated' | 'error' | 'unavailable'; message?: string }

const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] })
const partialDate = { type: 'string', description: 'YYYY, YYYY-MM or YYYY-MM-DD' }

/** JSON schema for output_config.format (structured outputs subset: no numeric bounds). */
export const REFINE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['archetype', 'title', 'contentMd', 'tags', 'date', 'referenceDate', 'entityKind', 'demonQuery', 'mass', 'temperature', 'links'],
  properties: {
    archetype: { type: 'string', enum: [...ARCHETYPES] },
    title: { type: 'string' },
    contentMd: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    date: {
      type: 'object',
      additionalProperties: false,
      required: ['iso', 'precision'],
      properties: { iso: partialDate, precision: { type: 'string', enum: [...PRECISION] } },
    },
    referenceDate: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['iso', 'precision', 'label'],
      properties: { iso: partialDate, precision: { type: 'string', enum: [...PRECISION] }, label: { type: 'string' } },
    }),
    entityKind: nullable({ type: 'string', enum: [...ENTITY_KINDS] }),
    demonQuery: nullable({ type: 'string' }),
    mass: { type: 'number' },
    temperature: { type: 'number' },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['targetId', 'kind', 'label'],
        properties: { targetId: { type: 'string' }, kind: { type: 'string', enum: [...LINK_KINDS] }, label: nullable({ type: 'string' }) },
      },
    },
  },
} as const

export const REFINE_SYSTEM = `You turn one line a person typed into a record in their personal "worldview" knowledge base: a 3D world where height is time.

Pick the archetype:
- idea: a concept, belief, claim or question
- entity: a person, place, organization or work that exerts pull (set entityKind)
- lens: a framework or way of seeing
- document: a text, paper, note or source
- memory: a lived moment or experience
- demon: a standing query that should gather matching nodes (set demonQuery to its search terms)

Fields:
- title: short and specific, in the person's own words where possible (no trailing period).
- contentMd: a few sentences of Markdown expanding what they wrote. Do not invent facts about the person; general background about a public subject is fine.
- tags: 1-6 lowercase topic tags; the first is the primary tag.
- date: when this entered the person's life or worldview. Use what they said ("in 2019", "last summer"); otherwise today. Never before t0 or after today.
- referenceDate: a separate historical date of the subject itself (e.g. a paper's publication year), else null.
- mass: significance from 0.25 (passing) to 4 (life-defining); 1 is ordinary.
- temperature: volatility from 0 (settled) to 1 (actively changing their mind).
- links: only to ids from the candidates list, only when the relation is clear.`
