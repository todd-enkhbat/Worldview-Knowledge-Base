// World-scale constants. Physics-kernel constants (Q formats, potentials) live in src/physics/.

/** World units of height per year of biographical time (Y = time). */
export const Y_PER_YEAR = 12
/** Physics steps per year at dt = 1/60 s: one year passes in 10 s at 1× speed. */
export const STEPS_PER_YEAR = 600
export const DT_SECONDS = 1 / 60
export const MS_PER_YEAR = 365.2425 * 86_400_000

/** Future plans are allowed up to now + 5 y. */
export const FUTURE_YEARS = 5
/** span · Y_PER_YEAR ≤ 3000 u  ⇒ ≤ 250 y. */
export const MAX_SPAN_UNITS = 3000
export const MAX_ANCHOR_RADIUS = 3000
/** Pair-core range σ (world units); anchors must be at least σ apart. */
export const SIGMA = 3

export const MASS_RANGE: readonly [number, number] = [0.25, 4]
export const TEMPERATURE_RANGE: readonly [number, number] = [0, 1]

/** Helical catwalk: one turn per year. */
export const HELIX_RADIUS = 13
export const HELIX_PITCH = Y_PER_YEAR

/** Soft-delete retention. */
export const TRASH_RETENTION_MS = 30 * 86_400_000
/** Nag when the last backup is older than this. */
export const BACKUP_NAG_MS = 3 * 86_400_000
