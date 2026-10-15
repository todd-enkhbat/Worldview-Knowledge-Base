import { useEffect, useMemo } from 'react'
import type { BufferGeometry } from 'three'
import {
  LENS,
  TESSERACT,
  crystalGeometry,
  demonBodyGeometry,
  demonFieldGeometry,
  demonRingGeometry,
  demonSlitGeometry,
  ghostGeometries,
  lensConeGeometry,
  lensDiscGeometry,
  lensLimbGeometry,
  lensRimGeometry,
  lensRingGeometry,
  monolithGeometry,
  monolithSeamGeometry,
  reticleGeometry,
  shellGeometry,
  slabGeometry,
  slabRuleGeometry,
  tesseractGlowGeometry,
  tesseractPlaqueGeometry,
  tesseractRimGeometry,
  tesseractStrutGeometry,
  vectorGeometry,
} from './geometry.ts'
import { createNodeMaterials, type NodeMaterials } from './materials.ts'

// Every GPU resource the node layer owns, created once per mount and disposed on unmount.

function createGeometries() {
  return {
    crystal: crystalGeometry(),
    monolith: monolithGeometry(),
    monolithSeam: monolithSeamGeometry(),
    vector: vectorGeometry(),
    lensLimb: lensLimbGeometry(),
    lensRingB: lensRingGeometry(LENS.ringB),
    lensRingC: lensRingGeometry(LENS.ringC, 0.022),
    lensDisc: lensDiscGeometry(),
    lensRim: lensRimGeometry(),
    lensCone: lensConeGeometry(),
    slab: slabGeometry(),
    slabRule: slabRuleGeometry(),
    tessRim: tesseractRimGeometry(),
    tessStrut: tesseractStrutGeometry(),
    tessGlow: tesseractGlowGeometry(),
    tessPlaque: tesseractPlaqueGeometry(),
    backShell: shellGeometry(TESSERACT.shell - 0.01),
    frontShell: shellGeometry(TESSERACT.shell),
    depthProxy: shellGeometry(TESSERACT.shell),
    demonBody: demonBodyGeometry(),
    demonRing: demonRingGeometry(),
    demonSlit: demonSlitGeometry(),
    demonField: demonFieldGeometry(),
    reticleSelect: reticleGeometry(0.02, true),
    reticleHover: reticleGeometry(0.011, false),
    ghost: ghostGeometries(),
  }
}

export type NodeGeometries = ReturnType<typeof createGeometries>

export interface NodeKit {
  geo: NodeGeometries
  mat: NodeMaterials
  time: { value: number }
}

function disposeGeometries(geo: NodeGeometries): void {
  for (const [key, g] of Object.entries(geo)) {
    if (key === 'ghost') for (const gg of Object.values(g as Record<string, BufferGeometry>)) gg.dispose()
    else (g as BufferGeometry).dispose()
  }
}

export function useNodeKit(): NodeKit {
  const kit = useMemo(() => {
    const materials = createNodeMaterials()
    const geo = createGeometries()
    return {
      kit: { geo, mat: materials.mat, time: materials.time } satisfies NodeKit,
      dispose: () => {
        materials.dispose()
        disposeGeometries(geo)
      },
    }
  }, [])
  useEffect(() => kit.dispose, [kit])
  return kit.kit
}
