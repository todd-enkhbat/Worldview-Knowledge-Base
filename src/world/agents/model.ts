import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import { buildIndex } from '../../overlay/bm25.ts'
import { matchDemon, sortable, type DemonMatch } from '../../overlay/demon.ts'
import { anchorOfFor } from '../../overlay/fields.ts'
import { getPoseTable, type PoseTable } from '../poses.ts'

export interface QueryAgent {
  record: NodeRecord
  match: DemonMatch
  active: boolean
  route: string[]
}

/** The avatars and panel use the same local keyword/radius matcher as saved demons. */
export function queryAgents(records: Iterable<NodeRecord>, settings: Pick<WorldSettings, 'T0' | 'yPerYear'>, poses: AgentPoses = getPoseTable()): QueryAgent[] {
  const all = [...records].filter((r) => r.deletedAt === null)
  const population = sortable(all).filter((record) => {
    const row = poses.index.get(record.id)
    return row === undefined ? record.temporalOrigin <= Date.now() : poses.born[row] === 1
  })
  const index = buildIndex(population)
  const anchorOf = anchorOfFor(settings, all, poses)
  return all.filter((r) => r.archetype === 'demon' && r.demon).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map((record) => {
    const match = matchDemon(record, population, index, anchorOf)
    return { record, match, active: record.demon!.active && record.demon!.query.trim().length > 0, route: match.hits.slice(0, 8).map((hit) => hit.id) }
  })
}

export type AgentPoint = { x: number; y: number; z: number }
type AgentPoses = Pick<PoseTable, 'index' | 'pos' | 'born'>

/** Routes only visit existing, born records; a paused or unmatched scout stays at home. */
export function sampleAgentRoute(ids: readonly string[], poses: AgentPoses, seconds: number, home: AgentPoint, out: AgentPoint): number {
  const rows: number[] = []
  for (const id of ids) {
    const row = poses.index.get(id)
    if (row === undefined || poses.born[row] !== 1) continue
    const offset = row * 3
    if (Number.isFinite(poses.pos[offset]) && Number.isFinite(poses.pos[offset + 1]) && Number.isFinite(poses.pos[offset + 2])) rows.push(row)
  }
  if (!rows.length) {
    out.x = home.x; out.y = home.y; out.z = home.z
    return 0
  }
  const time = Math.max(0, seconds)
  if (rows.length === 1) {
    const offset = rows[0] * 3
    out.x = poses.pos[offset] + Math.cos(time * .24) * 5
    out.y = poses.pos[offset + 1] + 8 + Math.sin(time * .65) * .8
    out.z = poses.pos[offset + 2] + Math.sin(time * .24) * 5
    return 1
  }
  const leg = time / 9
  const from = rows[Math.floor(leg) % rows.length] * 3
  const to = rows[(Math.floor(leg) + 1) % rows.length] * 3
  const f = leg % 1
  const eased = f * f * (3 - 2 * f)
  out.x = poses.pos[from] + (poses.pos[to] - poses.pos[from]) * eased
  out.y = poses.pos[from + 1] + (poses.pos[to + 1] - poses.pos[from + 1]) * eased + 8 + Math.sin(f * Math.PI) * 5
  out.z = poses.pos[from + 2] + (poses.pos[to + 2] - poses.pos[from + 2]) * eased
  return rows.length
}

export const OPEN_AGENTS_EVENT = 'worldview:open-agents'
export function openAgentsPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_AGENTS_EVENT))
}
