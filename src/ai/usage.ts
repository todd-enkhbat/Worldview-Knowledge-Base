import { create } from 'zustand'
import { getStore, isRepoReady } from '../data/repo.ts'

// What the AI features have cost, kept with the world (kv 'ai.usage', exported in kv.json) so
// the estimate survives reloads. Tokens are counted from each response's usage; dollars are an
// estimate from the list prices below (first-party API, standard speed, short context; Anthropic 5-minute cache writes).

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageLedger {
  /** Tokens per model id, since `since` (epoch ms). */
  byModel: Record<string, TokenUsage>
  since: number
}

export const USAGE_KV = 'ai.usage'

/** USD per million tokens. Official provider model pages; GPT-6.2 Sol verified 2026-11-23.
 * Estimates exclude long-context tiers, regional/priority multipliers and tool fees. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'gpt-6.2-sol': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}
/** A 5-minute cache write costs 1.25× the input price. */
const CACHE_WRITE_FACTOR = 1.25

export const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Estimated USD for some tokens on a model, or null when its price is unknown. */
export function estimateCost(model: string, u: TokenUsage): number | null {
  const p = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? '']
  if (!p) return null
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.input * CACHE_WRITE_FACTOR) / 1e6
}

export function addUsage(ledger: UsageLedger, model: string, u: Partial<TokenUsage>): UsageLedger {
  const prev = ledger.byModel[model] ?? ZERO
  return {
    ...ledger,
    byModel: {
      ...ledger.byModel,
      [model]: {
        input: prev.input + (u.input ?? 0),
        output: prev.output + (u.output ?? 0),
        cacheRead: prev.cacheRead + (u.cacheRead ?? 0),
        cacheWrite: prev.cacheWrite + (u.cacheWrite ?? 0),
      },
    },
  }
}

/** Total estimate; `unpriced` lists models with no known price. */
export function ledgerCost(ledger: UsageLedger): { usd: number; unpriced: string[] } {
  let usd = 0
  const unpriced: string[] = []
  for (const [model, u] of Object.entries(ledger.byModel)) {
    const c = estimateCost(model, u)
    if (c === null) unpriced.push(model)
    else usd += c
  }
  return { usd, unpriced }
}

export const useUsage = create<{ ledger: UsageLedger | null }>()(() => ({ ledger: null }))

export async function loadUsage(): Promise<UsageLedger> {
  const cur = useUsage.getState().ledger
  if (cur) return cur
  const stored = isRepoReady() ? await getStore().getKv<UsageLedger>(USAGE_KV).catch(() => undefined) : undefined
  const ledger = stored ?? { byModel: {}, since: Date.now() }
  useUsage.setState({ ledger })
  return ledger
}

/** Add one response's usage to the world's ledger. */
export async function recordUsage(model: string, u: Partial<TokenUsage>): Promise<void> {
  const ledger = addUsage(await loadUsage(), model, u)
  useUsage.setState({ ledger })
  if (isRepoReady()) await getStore().putKv(USAGE_KV, ledger).catch(() => {})
}

export async function resetUsage(now = Date.now()): Promise<void> {
  const ledger: UsageLedger = { byModel: {}, since: now }
  useUsage.setState({ ledger })
  if (isRepoReady()) await getStore().putKv(USAGE_KV, ledger).catch(() => {})
}
