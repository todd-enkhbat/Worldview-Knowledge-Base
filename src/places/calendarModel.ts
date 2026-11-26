import { z } from 'zod'
import { placeEntrySchema } from './types.ts'

export const CALENDAR_PLACES_KEY = 'places.calendar.v1'
const accountSchema = z.object({ id: z.string(), label: z.string(), syncedAt: z.number(), entries: z.array(placeEntrySchema) })
const calendarSchema = z.object({ revision: z.number().int().nonnegative(), accounts: z.array(accountSchema), photos: z.object({ automatic:z.boolean(), lastRead:z.number() }).optional() })
export const decodeCalendarPlaces = (value: unknown) => calendarSchema.parse(value ?? { revision: 0, accounts: [] })
export type CalendarPlaces = ReturnType<typeof decodeCalendarPlaces>
