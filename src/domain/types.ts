// Domain contracts shared by the store, the editor, the renderer and the physics world builder.
// Positions and velocities are never persisted: they are a deterministic function of
// (records, settings, step). See docs/DECISIONS.md.

export const SCHEMA_VERSION = 1

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

/** Visual + semantic kind of a node. One mesh family per archetype. */
export type Archetype =
  | 'idea' //     faceted crystal: a concept, belief or question
  | 'entity' //   obsidian monolith: a person, place, organisation or work that exerts pull
  | 'lens' //     brass/dark-glass astrolabe: a framework or way of seeing
  | 'document' // concrete slab with text: a text, note or source
  | 'memory' //   tesseract: a lived moment; may hold a volumetric splat diorama
  | 'demon' //    Maxwell's demon: a standing query that sorts matching nodes

export const ARCHETYPES: readonly Archetype[] = ['idea', 'entity', 'lens', 'document', 'memory', 'demon']

export type TemporalPrecision = 'year' | 'month' | 'day' | 'minute'
export type Visibility = 'private' | 'public'
export type EntityKind = 'person' | 'place' | 'organization' | 'work' | 'other'
export type LinkKind = 'relates' | 'supports' | 'contradicts' | 'derives' | 'influenced-by'

export interface Link {
  targetId: string
  kind: LinkKind
  label?: string
  createdAt: number
}

/**
 * An original kept with a note: any file. 'image' and 'text' get previews; 'file' is anything
 * else (PDF, video, audio, zip, dataset, contact card, database…), kept byte for byte.
 */
export interface Attachment {
  id: string
  kind: 'image' | 'text' | 'file'
  name: string
  mime: string
  bytes: number
  /** OPFS blob holding the original bytes. */
  blobId: string
  /** OPFS blob holding a small webp thumbnail (images only). */
  thumbBlobId?: string
  createdAt: number
}

/**
 * Something live that a note points at rather than stores: a video that plays in place, a web
 * page, or a place on the map.
 */
export interface Embed {
  id: string
  kind: 'youtube' | 'web' | 'place'
  /** The page or video URL (absent for a place given only by address). */
  url?: string
  title?: string
  place?: { name: string; address?: string; lat?: number; lng?: number }
  addedAt: number
}

export interface ThermoBlock {
  /** Inertia. Range [0.25, 4]. Higher = more significant, harder to move. */
  mass: number
  /** Volatility. Range [0, 1]. Couples the node to the chaotic landscape (τ_i). */
  temperature: number
}

export interface Pose {
  position: Vec3
  quaternion: Quat
  fov?: number
}

/** Volumetric diorama inside a memory tesseract. Asset ids refer to OPFS blobs. */
export interface SplatBlock {
  /** ≤100k-splat decimated SPZ v3, resident while near. */
  proxyAssetId: string | null
  /** Full-resolution SPZ v3, streamed with LoD only when focused. */
  interiorAssetId: string | null
  /** Small webp impostor. */
  thumbAssetId: string | null
  /** Where the camera rests after the fly-in, in splat-local units. */
  entryPose: Pose
  /** Clip box in native splat units (same units as the SplatEdit BOX). Null = no crop. */
  crop: { min: Vec3; max: Vec3 } | null
  /** Orientation fix applied before cropping (e.g. Y-down captures). */
  upFix: Quat
  counts: { interior: number; proxy: number }
  sourceFormat: 'spz' | 'ply' | 'splat' | 'ksplat' | 'sog' | 'rad' | 'unknown'
}

export interface DemonBlock {
  /** Matcher v1: BM25-lite over title, tags and content. */
  query: string
  /** World units within which matched nodes are sorted onto lattice slots. */
  radius: number
  active: boolean
}

export interface ReferenceDate {
  epochMs: number
  precision: TemporalPrecision
  label?: string
}

export interface NodeRecord {
  id: string
  slug: string
  archetype: Archetype
  title: string
  contentMd: string
  tags: string[]
  /** When this entered the user's life or worldview (epoch ms). Sets the history birth step; XYZ are semantic space. */
  temporalOrigin: number
  temporalPrecision: TemporalPrecision
  /** Display-only historical date (e.g. Boltzmann's H-theorem, 1872). Never affects layout. */
  referenceDate: ReferenceDate | null
  thermo: ThermoBlock
  /** Legacy placement hint retained for imports/editors. Shared semantic XYZ are derived from tags and links. */
  anchorXZ: [number, number]
  /** Explicit XZ pin set by dragging; baked into the shared spatial anchor, while Y remains semantic. */
  fieldAnchorXZ?: [number, number]
  links: Link[]
  attachments: Attachment[]
  /** Live things the note points at (videos, pages, places). Optional: older records have none. */
  embeds?: Embed[]
  visibility: Visibility
  /** Retained source hidden from active search and spatial projections, independently of trash. */
  corpusExcluded?: boolean
  splat?: SplatBlock
  entity?: { kind: EntityKind }
  demon?: DemonBlock
  /** Where the record came from when not typed in the editor (Phase 4 omnibox). */
  libraryOrigin?: 'saved' | 'example'
  provenance?: Provenance
  createdAt: number
  updatedAt: number
  /** Soft delete (30-day trash). */
  deletedAt: number | null
  schemaVersion: number
}

/**
 * Where a record came from. Omnibox origin: 'provisional' records were spawned from the raw text by heuristics in
 * under 1.5 s; 'refined' ones were rewritten by the model; 'fallback' means refinement
 * failed or was refused and the heuristic record was kept.
 */
export type Provenance = OmniboxProvenance | IntakeProvenance

export interface OmniboxProvenance {
  source: 'omnibox'
  state: 'provisional' | 'refined' | 'fallback'
  /** The text the user typed. */
  raw: string
  refinedAt?: number
}

/**
 * Milestone 1 intake: a note kept from the chat (Claude proposed it from the conversation, a
 * dropped file or a URL) or imported from an Obsidian vault.
 */
export interface IntakeProvenance {
  source: 'chat' | 'file' | 'url' | 'obsidian'
  /** Original format metadata retained through portable exports (never privileged instructions). */
  sourceMetadata?: Record<string, unknown>
  /** File name, URL or vault-relative path the note came from (absent for plain conversation). */
  ref?: string
  /** The supporting passage Claude quoted from the source, if any. */
  quote?: string
  /** Model that proposed it (absent for a vault import). */
  model?: string
  keptAt: number
}

export type QualityTier = 'auto' | 'high' | 'medium' | 'low'

export interface WorldSettings {
  /** Birth date or worldview start (epoch ms). Captured at first run; never derived from data. */
  T0: number
  yPerYear: number
  stepsPerYear: number
  physicsSeed: number
  qualityTier: QualityTier
  firstRunComplete: boolean
  lastBackupAt: number | null
  autoBackupEnabled: boolean
  createdAt: number
  schemaVersion: number
}

/** Interaction log driving the dissipative overlays (Hebbian trace, synapses, demons). */
export type InteractionKind = 'dwell' | 'inspect' | 'enter' | 'demon-match'

export interface InteractionEvent {
  id: string
  /** Wall-clock epoch ms. Plasticity follows real interaction, not the scrub. */
  t: number
  kind: InteractionKind
  nodeId: string
  /** Activation amplitude A_k; defaults per kind. */
  amplitude?: number
  /** For demon-match: the demon that recorded it, and bits of information it stored. */
  demonId?: string
  bits?: number
}

export type AssetKind = 'splat-proxy' | 'splat-interior' | 'splat-thumb' | 'image' | 'image-thumb' | 'text' | 'file'

export interface AssetMeta {
  id: string
  kind: AssetKind
  mime: string
  bytes: number
  createdAt: number
  /** Node that owns it (for orphan collection). */
  nodeId: string | null
}
