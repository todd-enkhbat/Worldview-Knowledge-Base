import type { CrmCalendar, CrmGoogleAccount } from '../crm/connectionTypes.ts'
import { crmConnectionRequest } from '../crm/CrmConnections.tsx'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { coordinateText, mapUrlCoordinates, safePlaceUrl } from './coordinates.ts'
import type { PlaceEntry } from './types.ts'

import { CALENDAR_PLACES_KEY, decodeCalendarPlaces, type CalendarPlaces } from './calendarModel.ts'
export { CALENDAR_PLACES_KEY, decodeCalendarPlaces, type CalendarPlaces } from './calendarModel.ts'

type Venue = { id: string; title: string; location: string; startAt: number | null; endAt: number | null; htmlLink: string; provider: 'luma' | 'partiful' | 'calendar' }
const iso = (v: number | null) => v === null ? null : new Date(v).toISOString()

export async function readCalendarPlaces() { return decodeCalendarPlaces(await getStore().getKv(CALENDAR_PLACES_KEY)) }

async function editCalendarPlaces(change: (accounts: CalendarPlaces['accounts']) => CalendarPlaces['accounts']) {
  const store = getStore(), generation = getWorldGeneration()
  const before = await readCalendarPlaces()
  if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation || !useRepoStatus.getState().writer) throw new Error('Open the editing window to change map sources.')
  const next = { ...before, revision: before.revision + 1, accounts: change(before.accounts) }
  await compareAndSwapWorldState(CALENDAR_PLACES_KEY, next, before.revision)
  return next
}
export function setCalendarSource(account: Pick<CrmGoogleAccount,'id'|'label'|'email'>, enabled: boolean) {
  return editCalendarPlaces(accounts => enabled
    ? accounts.some(a => a.id === account.id) ? accounts : [...accounts, { id: account.id, label: account.email || account.label, syncedAt: 0, entries: [] }]
    : accounts.filter(a => a.id !== account.id))
}

export async function refreshCalendarPlaces(accountId: string, signal: AbortSignal) {
  const store = getStore(), generation = getWorldGeneration()
  const before = await readCalendarPlaces(), account = before.accounts.find(row => row.id === accountId)
  if (!account) return
  const { calendars, complete } = await crmConnectionRequest<{calendars: CrmCalendar[]; complete: boolean}>('google/calendars', {accountId}, signal)
  if (!complete) throw new Error('Google returned a partial calendar list. Your last complete set of venues is available.')
  const now = Date.now(), day = 86_400_000
  const timeMin = iso(now - 300 * day), timeMax = iso(now + 65 * day)
  const entries: PlaceEntry[] = []
  for (const calendar of calendars.filter(c => c.primary || c.selected)) {
    let pageToken: string | null = null
    const tokens = new Set<string>()
    do {
      const page: { venues: Venue[]; nextPageToken: string | null } = await crmConnectionRequest('google/venues', { accountId, calendarId: calendar.id, timeMin, timeMax, pageToken }, signal)
      for (const venue of page.venues) {
        const point = coordinateText(venue.location) ?? mapUrlCoordinates(venue.location)
        entries.push({ id: 'gcal:' + JSON.stringify([account.id, calendar.id, venue.id]), title: venue.title, address: venue.location, latitude: point?.[0] ?? null, longitude: point?.[1] ?? null, provider: venue.provider, account: account.label, kind: 'event', startedAt: iso(venue.startAt), endedAt: iso(venue.endAt), url: safePlaceUrl(venue.htmlLink), detail: calendar.summary, sourceFile: 'Google Calendar', importedAt: now })
      }
      pageToken = page.nextPageToken
      if (pageToken && tokens.has(pageToken)) throw new Error('Google repeated a page of events. Try refreshing again.')
      if (pageToken) tokens.add(pageToken)
    } while (pageToken)
  }
  if (signal.aborted || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return
  await editCalendarPlaces(accounts => accounts.map(a => a.id === accountId ? { ...a, entries, syncedAt: now } : a))
}

export async function setPhotoAutoRefresh(automatic: boolean, lastRead: number) {
  const store=getStore(), generation=getWorldGeneration(), before=await readCalendarPlaces()
  if (!isRepoReady() || store!==getStore() || generation!==getWorldGeneration()) throw new Error('The workspace changed before Photos preferences could be saved.')
  await compareAndSwapWorldState(CALENDAR_PLACES_KEY,{ ...before, revision: before.revision+1, photos:{automatic,lastRead} },before.revision)
}
