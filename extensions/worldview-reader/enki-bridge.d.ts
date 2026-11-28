export function createEnkiBridge(dependencies: Record<string, unknown>): {
  configure: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>
  wake: () => Promise<void>
  summon: (sender: { frameId: number; documentId: string; tab: { id: number } }) => Promise<{ ok: boolean }>
}
