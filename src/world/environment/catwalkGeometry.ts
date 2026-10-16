import type { BufferGeometry } from 'three'
import type { PathGraph } from '../paths.ts'
import { SweepBuilder, deckProfile, railProfile, type Profile } from './geometry.ts'
import { INNER_R_OFFSET, type DeckPiece } from './layout.ts'

// Swept catwalk meshes (pure; no React): the deck with its landings as one geometry and the
// handrails as another.

const RAIL_TOP = 1.05
const RAIL_MID = 0.55

function profileFor(p: DeckPiece, innerR: number): Profile {
  switch (p.kind) {
    case 'ramp':
      return deckProfile({ innerR, outerR: p.outerR, depth: 0.42, fasciaDepth: 1.05, fasciaWidth: 0.45, outer: p.outer })
    case 'landing':
      return deckProfile({ innerR, outerR: p.outerR, depth: 0.55, fasciaDepth: 1.7, fasciaWidth: 0.7, outer: p.outer })
    case 'present':
      return deckProfile({
        innerR,
        outerR: p.outerR,
        depth: 0.6,
        fasciaDepth: 2.3,
        fasciaWidth: 0.9,
        outer: p.outer,
        wallHeight: 0.8,
        wallWidth: 0.4,
      })
  }
}

export function buildCatwalkGeometry(g: PathGraph, pieces: readonly DeckPiece[]): { deck: BufferGeometry; rails: BufferGeometry } {
  const h = g.helix
  const turns = (h.yMax - h.yMin) / h.pitch
  const spt = turns > 80 ? 32 : 64
  const helix = { radius: h.radius, pitch: h.pitch, phase0: h.phase0 }
  const innerR = h.radius - INNER_R_OFFSET

  const deck = new SweepBuilder(helix, spt)
  for (const p of pieces) deck.sweep(profileFor(p, innerR), p.y0, p.y1, true)

  const rails = new SweepBuilder(helix, spt)
  const rIn = innerR + 0.07
  rails.sweep(railProfile(rIn, RAIL_TOP, 0.07, 0.05), h.yMin, h.yMax)
  rails.sweep(railProfile(rIn, RAIL_MID, 0.03, 0.03), h.yMin, h.yMax)
  for (const p of pieces) {
    if (p.outer !== 'rail') continue
    const rOut = p.outerR - 0.07
    rails.sweep(railProfile(rOut, RAIL_TOP, 0.07, 0.05), p.y0, p.y1)
    rails.sweep(railProfile(rOut, RAIL_MID, 0.03, 0.03), p.y0, p.y1)
  }
  return { deck: deck.build(), rails: rails.build() }
}
