import type { Archetype, NodeRecord } from '../../domain/types.ts'

/** Render samples belonging to one actual record, never independent world records. */
export interface MolecularPacket {
  offsets: Float32Array
  phases: Float32Array
  sizes: Float32Array
  /** 0 = dense volume, 1 = orbital filament, 2 = diffuse halo. */
  roles: Float32Array
}

/** A sparse local scaffold inside one note's volume; these are not saved knowledge links. */
export function molecularBonds(packet: MolecularPacket, maxSites = 128, neighbors = 2): Uint32Array {
  const count = packet.roles.length
  if (count < 2 || maxSites < 2 || neighbors < 1) return new Uint32Array()
  const sites: number[] = []
  const stride = Math.max(1, Math.ceil(count / maxSites))
  for (let i = 0; i < count; i += stride) if (packet.roles[i] !== 2) sites.push(i)
  const pairs = new Set<string>(), edges: number[] = []
  for (const from of sites) {
    const nearest = sites.filter((to) => to !== from).map((to) => ({ to, distance:
      Math.hypot(packet.offsets[from * 3]! - packet.offsets[to * 3]!, packet.offsets[from * 3 + 1]! - packet.offsets[to * 3 + 1]!, packet.offsets[from * 3 + 2]! - packet.offsets[to * 3 + 2]!),
    })).sort((a, b) => a.distance - b.distance || a.to - b.to).slice(0, Math.min(3, neighbors))
    for (const { to } of nearest) {
      const a = Math.min(from, to), b = Math.max(from, to), key = `${a}:${b}`
      if (!pairs.has(key)) { pairs.add(key); edges.push(a, b) }
    }
  }
  return Uint32Array.from(edges)
}

interface Profile {
  radius: number
  core: number
  filament: number
  lobes: number
  stretch: readonly [number, number, number]
}

const PROFILES: Record<Archetype, Profile> = {
  idea: { radius: 21, core: 0.42, filament: 0.35, lobes: 3, stretch: [1.1, 1.15, 0.95] },
  entity: { radius: 19, core: 0.57, filament: 0.23, lobes: 2, stretch: [1, 1.25, 1] },
  lens: { radius: 23, core: 0.27, filament: 0.53, lobes: 4, stretch: [1.05, 1.1, 1.05] },
  document: { radius: 20, core: 0.57, filament: 0.23, lobes: 3, stretch: [1.05, 1.2, 0.95] },
  memory: { radius: 24, core: 0.49, filament: 0.31, lobes: 4, stretch: [1, 1.15, 1.1] },
  demon: { radius: 24, core: 0.25, filament: 0.53, lobes: 5, stretch: [1.05, 1.2, 1] },
}

function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function molecularCounts(records: readonly NodeRecord[], max = 260_000): number[] {
  const planned = records.map((r) => r.deletedAt !== null ? 0 : Math.round(1400 + 420 * (r.thermo?.mass ?? 1) + 55 * Math.min(r.attachments.length, 4) + 35 * Math.min(r.contentMd.length / 400, 6)))
  const total = planned.reduce((sum, n) => sum + n, 0)
  const scale = Math.min(1, Math.max(0, max) / Math.max(1, total))
  return planned.map((n) => Math.floor(n * scale))
}

/**
 * A mixture of true 3-D radial volumes, asymmetrical lobes, inclined orbital filaments and
 * diffuse falloff. There are no rows, sheets, lattice indices or rectangular envelopes.
 * Identity fixes the seed, archetype fixes the profile, significance sets the formation's
 * scale. Bounded GPU curls rotate these samples without modifying the semantic anchor.
 */
export function createMolecularPacket(record: Pick<NodeRecord, 'id' | 'archetype' | 'thermo'>, count: number, degree = 0): MolecularPacket {
  const n = Math.max(0, Math.floor(count))
  const offsets = new Float32Array(n * 3)
  const phases = new Float32Array(n)
  const sizes = new Float32Array(n)
  const roles = new Float32Array(n)
  const rand = random(hash(record.id))
  const profile = PROFILES[record.archetype] ?? PROFILES.idea
  const radius = profile.radius * (0.8 + 0.14 * Math.sqrt(record.thermo?.mass ?? 1) + 0.025 * Math.min(8, degree))
  const phase = rand() * Math.PI * 2
  const yaw = rand() * Math.PI * 2
  const pitch = rand() * Math.PI * 2
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  for (let i = 0; i < n; i++) {
    const population = rand()
    const arm = Math.floor(rand() * profile.lobes)
    const armPhase = phase + arm / profile.lobes * Math.PI * 2
    let x: number
    let y: number
    let z: number
    if (population < profile.core) {
      // Fill the interior volume instead of piling samples onto a bright central speck.
      const r = radius * Math.cbrt(0.001 + rand() * 0.55)
      const height = rand() * 2 - 1
      const a = rand() * Math.PI * 2
      const flat = Math.sqrt(1 - height * height)
      const lobe = radius * 0.15 * Math.sin(r / radius * Math.PI)
      x = Math.cos(a) * flat * r + Math.cos(armPhase) * lobe
      y = height * r + Math.sin(armPhase * 1.7) * lobe
      z = Math.sin(a) * flat * r + Math.sin(armPhase) * lobe
      roles[i] = 0
    } else if (population < profile.core + profile.filament) {
      const u = rand()
      const r = radius * (0.15 + 0.82 * u)
      const a = armPhase + u * Math.PI * 2 * (0.7 + 0.25 * Math.sin(armPhase))
      const jitter = 0.12 + u * 0.7
      const px = Math.cos(a) * r
      const py = Math.sin(a) * r
      const tilt = 0.55 + arm / profile.lobes * 1.5
      x = px + (rand() - 0.5) * jitter
      y = py * Math.sin(tilt) + Math.sin(u * 7 + phase) * radius * 0.12 + (rand() - 0.5) * jitter
      z = py * Math.cos(tilt) + (rand() - 0.5) * jitter
      roles[i] = 1
    } else {
      const r = radius * (0.48 + 0.72 * Math.sqrt(rand()))
      const height = rand() * 2 - 1
      const a = rand() * Math.PI * 2
      const flat = Math.sqrt(1 - height * height)
      x = Math.cos(a) * flat * r
      y = height * r
      z = Math.sin(a) * flat * r
      roles[i] = 2
    }
    x *= profile.stretch[0]
    y *= profile.stretch[1]
    z *= profile.stretch[2]
    const tiltedY = y * cp - z * sp
    const tiltedZ = z * cp + y * sp
    offsets.set([x * cy - tiltedZ * sy, tiltedY, x * sy + tiltedZ * cy], i * 3)
    phases[i] = phase / (Math.PI * 2)
    sizes[i] = Math.pow(rand(), 2.4)
  }
  return { offsets, phases, sizes, roles }
}
