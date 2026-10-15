// Dust allocation (PLAN "Dust (GPU)"): a fixed texel budget cut into 64-texel segments.
// Every funded owner keeps its segment for as long as it stays funded (a free-list), so an
// edit never moves another node's dust and the GPU state of untouched segments stays valid.
// Funding goes to memory nodes first, then by significance; owners beyond the budget get no
// dust. Pure and deterministic: the same candidates and history give the same segments.

/** Particles per owner: one allocation unit, and one row run of every power-of-two texture width ≥ 64. */
export const DUST_SEGMENT = 64
/** The full dust budget: 512 × 256 texels (2048 segments). */
export const DUST_BUDGET_TEXELS = 131072
export const DUST_TEXTURE_WIDTH = 512
export const DUST_BUDGET_SEGMENTS = DUST_BUDGET_TEXELS / DUST_SEGMENT

export interface DustCandidate {
  readonly id: string
  /** Memory nodes are funded before every other archetype. */
  readonly memory: boolean
  /** Higher is funded first among equals (finite; e.g. the node's mass). */
  readonly significance: number
  /** Older births are funded first among equals. */
  readonly birth: number
}

export interface DustAllocation {
  /** Budget in segments. */
  readonly segments: number
  readonly segmentOf: ReadonlyMap<string, number>
  /** Owner id per segment (null = free). */
  readonly ownerOf: readonly (string | null)[]
  /** Highest occupied segment + 1: the texel rows that need stepping and drawing. */
  readonly used: number
}

export interface AllocationDiff {
  /** Owners that got a segment (new or newly funded), in rank order. */
  readonly assigned: readonly { readonly id: string; readonly segment: number }[]
  /** Owners that lost their segment (removed or no longer funded). */
  readonly released: readonly { readonly id: string; readonly segment: number }[]
}

/** Funding order: memory first, then significance (desc), birth (asc), id (code-unit order). */
export function compareCandidates(a: DustCandidate, b: DustCandidate): number {
  if (a.memory !== b.memory) return a.memory ? -1 : 1
  if (a.significance !== b.significance) return b.significance - a.significance
  if (a.birth !== b.birth) return a.birth - b.birth
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function emptyAllocation(segments: number): DustAllocation {
  if (!Number.isInteger(segments) || segments < 0) throw new RangeError(`dust budget ${segments} segments`)
  return { segments, segmentOf: new Map(), ownerOf: new Array<string | null>(segments).fill(null), used: 0 }
}

/**
 * Fund the top `budgetSegments` candidates. Funded owners that already hold a segment in
 * `prev` keep it; the others take the lowest free segment, in rank order (so the occupied
 * rows stay compact and the stepped/drawn region small). A budget change starts afresh.
 */
export function allocateDust(
  prev: DustAllocation | null,
  candidates: readonly DustCandidate[],
  budgetSegments: number,
): { allocation: DustAllocation; diff: AllocationDiff } {
  const base = prev && prev.segments === budgetSegments ? prev : emptyAllocation(budgetSegments)
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c.id)) throw new Error(`duplicate dust candidate ${c.id}`)
    if (!Number.isFinite(c.significance) || !Number.isFinite(c.birth)) throw new RangeError(`dust candidate ${c.id}: non-finite rank`)
    seen.add(c.id)
  }
  const ranked = [...candidates].sort(compareCandidates)
  const funded = ranked.slice(0, budgetSegments)
  const fundedIds = new Set(funded.map((c) => c.id))

  const ownerOf = base.ownerOf.slice()
  const segmentOf = new Map<string, number>()
  const released: { id: string; segment: number }[] = []
  // A budget change (prev ignored) releases everything prev held.
  if (prev && prev !== base) for (const [id, segment] of prev.segmentOf) released.push({ id, segment })
  for (const [id, segment] of base.segmentOf) {
    if (fundedIds.has(id)) segmentOf.set(id, segment)
    else {
      ownerOf[segment] = null
      released.push({ id, segment })
    }
  }
  released.sort((a, b) => a.segment - b.segment)

  const assigned: { id: string; segment: number }[] = []
  let cursor = 0
  for (const c of funded) {
    if (segmentOf.has(c.id)) continue
    while (ownerOf[cursor] !== null) cursor++
    ownerOf[cursor] = c.id
    segmentOf.set(c.id, cursor)
    assigned.push({ id: c.id, segment: cursor })
  }
  let used = 0
  for (let s = ownerOf.length - 1; s >= 0; s--) {
    if (ownerOf[s] !== null) {
      used = s + 1
      break
    }
  }
  return { allocation: { segments: budgetSegments, segmentOf, ownerOf, used }, diff: { assigned, released } }
}

/** Texel origin of a segment in a texture of the given width (a multiple of DUST_SEGMENT). */
export function segmentOrigin(segment: number, width: number): { x: number; y: number } {
  if (width % DUST_SEGMENT !== 0) throw new RangeError(`texture width ${width} is not a multiple of ${DUST_SEGMENT}`)
  const t = segment * DUST_SEGMENT
  return { x: t % width, y: Math.floor(t / width) }
}

/** Texture rows that hold segments [0, used). */
export function rowsForSegments(used: number, width: number): number {
  return Math.ceil((used * DUST_SEGMENT) / width)
}
