import { describe, expect, it } from 'vitest'
import { toMono16k, transcriptMarkdown } from '../../src/ai/transcribe.ts'

describe('transcription helpers', () => {
  it('averages channels and resamples 48 kHz to 16 kHz', () => {
    const n = 48_000
    const l = new Float32Array(n).fill(1)
    const r = new Float32Array(n).fill(0)
    const out = toMono16k([l, r], 48_000)
    expect(out.length).toBe(16_000)
    expect(out[100]).toBeCloseTo(0.5)
    expect(toMono16k([new Float32Array([0.1, 0.2])], 16_000)).toEqual(new Float32Array([0.1, 0.2]))
  })

  it('writes timestamped lines', () => {
    expect(
      transcriptMarkdown({
        text: 'hello there. general',
        chunks: [
          { start: 0, end: 2, text: 'hello there.' },
          { start: 65.4, end: null, text: 'general' },
        ],
      }),
    ).toBe('[0:00] hello there.\n[1:05] general')
    expect(transcriptMarkdown({ text: 'plain', chunks: [] })).toBe('plain')
  })
})
