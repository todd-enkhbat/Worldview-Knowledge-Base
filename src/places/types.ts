import { z } from 'zod'

export const PLACES_KEY = 'places.v1'
export const placeProviders = ['google-maps', 'apple-maps', 'luma', 'partiful', 'calendar', 'apple-photos', 'file'] as const
export type PlaceProvider = typeof placeProviders[number]
export const placeEntrySchema = z.object({
  id: z.string().min(1), provider: z.enum(placeProviders), account: z.string(),
  kind: z.enum(['saved', 'visit', 'event', 'photo']), title: z.string().min(1), address: z.string(),
  latitude: z.number().min(-90).max(90).nullable(), longitude: z.number().min(-180).max(180).nullable(),
  startedAt: z.string().nullable(), endedAt: z.string().nullable(), url: z.string().refine(value => !value || /^https?:\/\//i.test(value)),
  detail: z.string(), sourceFile: z.string(), importedAt: z.number().nonnegative(),
  lists: z.array(z.object({ name: z.string(), detail: z.string() })).optional(),
  visualLabels: z.array(z.string().max(200)).max(100).optional(),
  thumbnail: z.string().regex(/^data:image\/(?:jpeg|webp);base64,[a-zA-Z0-9+/=]+$/).max(64_000).optional(),
}).refine(entry => (entry.latitude === null) === (entry.longitude === null))
export type PlaceEntry = z.infer<typeof placeEntrySchema>
export const placesSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), entries: z.array(placeEntrySchema) })
export type PlacesSnapshot = z.infer<typeof placesSchema>
export const emptyPlaces = (): PlacesSnapshot => ({ version: 1, revision: 0, entries: [] })
export const decodePlaces = (value: unknown) => value === undefined || value === null ? emptyPlaces() : placesSchema.parse(value)
export interface PlaceImportOptions { account?: string; provider?: PlaceProvider }
export interface PlaceImportReport { added: number; updated: number; unchanged: number; skipped: number; issues: string[] }
export interface NativePhotoRecord {
  id: string; title: string; filename?: string; latitude: number; longitude: number; date?: string
  description?: string; keywords?: string[]; visualLabels?: string[]; url?: string; thumbnail?: string; account?: string
}
