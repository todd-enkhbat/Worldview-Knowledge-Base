import { registerDevApi } from '../../app/devApi.ts'
import { openFraming } from './FramingRig.tsx'
import { flyIn, flyOut } from './FlyInRig.tsx'
import { splatStats } from './SparkLayer.tsx'

// Phase 2 splat rendering: the world's one SparkRenderer + tier manager (SplatLayer, mount
// once at the top level of the world scene, outside the world groups), the per-memory
// Diorama (mounted by the tesseract's diorama slot), and the camera rigs the CameraRig
// mounts for 'entering' / 'exiting' (FlyInRig), 'interior' (InteriorRig) and 'framing'
// (FramingRig, next to OrbitRig).

export { SparkLayer as SplatLayer } from './SparkLayer.tsx'
export { splatStats, LOD_CLEANUP_DEFAULT_MS, type SplatStats } from './SparkLayer.tsx'
export { Diorama, DIORAMA_HALF, FRAMING_HALF, getDiorama, liveSplatMeshes, type DioramaProps } from './Diorama.tsx'
export { FlyInRig, flyIn, flyOut, currentFlight, flightLodScale } from './FlyInRig.tsx'
export { InteriorRig, useWorldHidden } from './InteriorRig.tsx'
export {
  FramingRig,
  openFraming,
  closeFraming,
  saveFraming,
  captureEntryHere,
  applyUpFix,
  setCrop,
  setCropAxis,
  resetCrop,
  useFraming,
  type FramingDraft,
} from './FramingRig.tsx'
export { useSplatTiers, type SplatTier, type CrystalState, type CrystalPhase } from './tiers.ts'
export { getSpark, whenSpark, getSplatStage } from './sparkRegistry.ts'
export { WORLD_GROUP_NAMES } from './flyIn.ts'

// Dev hooks (window.__wv.*): registered at import, installed by installDevApi in dev builds.
registerDevApi('flyIn', (id: string) => flyIn(id))
registerDevApi('flyOut', () => flyOut())
registerDevApi('splatStats', () => splatStats())
registerDevApi('frameSplat', (id: string) => openFraming(id))
