import { registerDevApi } from './devApi.ts'

// First-occurrence timing marks for startup (ms since navigation), read with __wv.timings().
// Cheap enough to leave in: one map write per named mark, ever.

const marks = new Map<string, number>()

export function markOnce(name: string): void {
  if (!marks.has(name)) marks.set(name, Math.round(performance.now()))
}

registerDevApi('timings', () => Object.fromEntries(marks))
