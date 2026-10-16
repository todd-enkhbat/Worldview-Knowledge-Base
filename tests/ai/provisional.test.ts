import { describe, expect, it } from 'vitest'
import { parseDate, parseProvisional } from '../../src/ai/provisional.ts'

const NOW = Date.UTC(2026, 9, 16, 15)
const T0 = Date.UTC(1990, 4, 17)
const p = (s: string) => parseProvisional(s, { now: NOW, T0 })

describe('omnibox provisional parse', () => {
  it('guesses the archetype from the wording', () => {
    expect(p('I met Ada at the conference in 2019').archetype).toBe('memory')
    expect(p('Read the paper on transformers').archetype).toBe('document')
    expect(p('Entropy through the lens of information').archetype).toBe('lens')
    expect(p('watch for: anything about thermodynamics').archetype).toBe('demon')
    expect(p('watch for: anything about thermodynamics').demonQuery).toBe('anything about thermodynamics')
    expect(p('demon: sort by entropy').archetype).toBe('demon')
    expect(p("Maxwell's demon can't beat the second law").archetype).toBe('idea')
    expect(p('Free will is an illusion').archetype).toBe('idea')
    const ada = p('Ada Lovelace')
    expect(ada.archetype).toBe('entity')
    expect(ada.entityKind).toBe('other')
    expect(p('CERN').entityKind).toBe('organization')
  })

  it('pulls out #tags, a title and the rest as body', () => {
    const d = p('Time is a river. It only flows one way, says Boltzmann #time #Entropy #time')
    expect(d.tags).toEqual(['time', 'entropy'])
    expect(d.title).toBe('Time is a river')
    expect(d.contentMd).toContain('It only flows one way')
    expect(d.title.length).toBeLessThanOrEqual(80)
    expect(p('x'.repeat(300)).title.length).toBeLessThanOrEqual(80)
  })

  it('understands dates and clamps them to [T0, now]', () => {
    expect(p('in 2019 something changed')).toMatchObject({ temporalOrigin: Date.UTC(2019, 0, 1), temporalPrecision: 'year' })
    expect(p('march 2021 trip').temporalPrecision).toBe('month')
    expect(p('on 2024-02-29 it snowed')).toMatchObject({ temporalOrigin: Date.UTC(2024, 1, 29), temporalPrecision: 'day' })
    expect(p('back in 1950 my grandfather').temporalOrigin).toBe(T0)
    expect(p('a thought').temporalOrigin).toBe(Date.UTC(2026, 9, 16))
    expect(parseDate('yesterday', NOW)?.epochMs).toBe(Date.UTC(2026, 9, 15))
    expect(parseDate('nothing here', NOW)).toBeNull()
  })
})
