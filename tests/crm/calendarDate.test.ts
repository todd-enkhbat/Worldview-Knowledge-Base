import { expect, it } from 'vitest'
import { calendarEventDate } from '../../src/crm/calendarDate.ts'

it('keeps the badge and timestamp on the source timezone day across UTC midnight', () => {
  const result = calendarEventDate({ startAt: Date.parse('2026-08-28T02:00:00Z'), allDay: false, timezone: 'America/Denver' })
  expect(result.day).toBe('27'); expect(result.month).toBe('Aug'); expect(result.time).toContain('27'); expect(result.timezone).toBe('America/Denver')
})
it('keeps date-only all-day events on their original date regardless of the calendar timezone', () => {
  const result = calendarEventDate({ startAt: Date.parse('2026-08-28T00:00:00Z'), allDay: true, timezone: '' }, 'America/Los_Angeles')
  expect(result.day).toBe('28'); expect(result.time).toBe('All day'); expect(result.timezone).toBe('')
})
it('uses the selected calendar timezone when the event has none and handles an invalid source zone', () => {
  expect(calendarEventDate({ startAt: Date.parse('2026-08-28T02:00:00Z'), allDay: false, timezone: '' }, 'America/Denver').day).toBe('27')
  expect(calendarEventDate({ startAt: 0, allDay: false, timezone: 'invalid-zone' }).timezone).toContain('source timezone unrecognized')
  expect(calendarEventDate({ startAt: null, allDay: false, timezone: '' }).time).toBe('Original date retained')
})
