export interface DistrictLabelCandidate {
  id: string
  count: number
  x: number
  y: number
}

/** Keep readable neighborhood names until they leave view, rather than swapping them on orbit. */
export function chooseDistrictLabels(candidates: readonly DistrictLabelCandidate[], previous: ReadonlySet<string>, limit: number): string[] {
  const chosen: DistrictLabelCandidate[] = []
  const ordered = [...candidates].sort((a, b) => Number(previous.has(b.id)) - Number(previous.has(a.id)) || b.count - a.count || a.id.localeCompare(b.id))
  for (const candidate of ordered) {
    if (chosen.length >= limit) break
    if (chosen.some((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) < 110 || Math.abs(p.x - candidate.x) < 195 && Math.abs(p.y - candidate.y) < 54)) continue
    chosen.push(candidate)
  }
  return chosen.map((candidate) => candidate.id)
}
