import { describe, expect, it, vi } from 'vitest'
import { geocode, parseNominatim } from '../../src/ai/geocode.ts'

describe('geocoding a place', () => {
  it('reads the first hit and rejects nonsense', () => {
    expect(parseNominatim([{ lat: '40.8075', lon: '-73.9626' }])).toEqual({ lat: 40.8075, lng: -73.9626 })
    expect(parseNominatim([])).toBeNull()
    expect(parseNominatim([{ lat: 'x', lon: '1' }])).toBeNull()
    expect(parseNominatim({})).toBeNull()
  })

  it('asks Nominatim once per query and caches the answer', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ lat: '1.5', lon: '2.5' }])))
    expect(await geocode('116th and Broadway, New York', f as unknown as typeof fetch)).toEqual({ lat: 1.5, lng: 2.5 })
    expect(await geocode('116th and Broadway, New York', f as unknown as typeof fetch)).toEqual({ lat: 1.5, lng: 2.5 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('format=jsonv2')
  })
})
