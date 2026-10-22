import type Anthropic from '@anthropic-ai/sdk'
import { create } from 'zustand'
import { useWorld } from '../../app/store.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { addAttachment, addNodes, getStore, isRepoReady, link, updateNode } from '../../data/repo.ts'
import { proposalToDraft, searchWorld, URL_RE, urlToIntake, type IntakeItem } from './apply.ts'
import { TOOL_INPUTS, type AskUserInput, type ChatStreamEvent, type ProposedNote, type ToolName } from './protocol.ts'

// The chat intake session (milestone 1). The browser owns the conversation: it is
// append-only (thinking blocks stay valid), saved in the world's kv store, and every tool
// call is answered here. search_world runs at once and the turn continues; propose_notes
// and ask_user wait for the user, whose decisions go back as tool results with whatever
// they type next. Nothing reaches the world until a card is kept.

export type MessageParam = Anthropic.MessageParam
type ContentBlock = Anthropic.ContentBlockParam

export type CardStatus = 'open' | 'kept' | 'skipped' | 'edit'
export interface Card {
  key: string
  note: ProposedNote
  status: CardStatus
  /** World id once kept. */
  id?: string
  /** What the user asked Claude to change. */
  instruction?: string
  error?: string
}

export interface Ask {
  input: AskUserInput
  answer?: string
}

interface PendingTool {
  id: string
  name: ToolName | string
  /** Answered without the user (search, or an invalid input). */
  result?: string
  isError?: boolean
}

interface Persisted {
  history: MessageParam[]
  cards: Record<string, Card[]>
  asks: Record<string, Ask>
  laterKept: string[]
  contextDay: string | null
  model: string | null
}

export interface ChatState extends Persisted {
  loaded: boolean
  busy: boolean
  /** Text of the assistant turn being streamed. */
  live: string
  /** Name of the tool Claude is writing a call to, while it streams. */
  toolHint: string | null
  error: string | null
  /** Tool calls from the last assistant turn that still need a result. */
  pending: PendingTool[]
  staged: IntakeItem[]
  usage: { input: number; output: number; cacheRead: number }
}

const KV = 'chat.v1'
const AUTO_TURNS = 6

const empty: Persisted = { history: [], cards: {}, asks: {}, laterKept: [], contextDay: null, model: null }

export const useChat = create<ChatState>()(() => ({
  ...empty,
  loaded: false,
  busy: false,
  live: '',
  toolHint: null,
  error: null,
  pending: [],
  staged: [],
  usage: { input: 0, output: 0, cacheRead: 0 },
}))

// ─── originals ───────────────────────────────────────────────────────────────────────
// Files the user added this session, by name, so a kept note can store the original. They
// live in memory until kept; after a reload a card says its file must be dropped again.

const originals = new Map<string, File>()

function rememberOriginal(file: File): void {
  originals.set(file.name, file)
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  if (rel) originals.set(rel, file)
}

/** The originals a proposal should keep: its attach list, plus its source if that is a file. */
function originalsFor(note: ProposedNote): { found: File[]; missing: string[] } {
  const names = [...new Set([...(note.attach ?? []), ...(note.source.ref && !/^https?:\/\//.test(note.source.ref) ? [note.source.ref] : [])])]
  const found: File[] = []
  const missing: string[] = []
  for (const n of names) {
    const f = originals.get(n) ?? originals.get(n.split('/').pop()!)
    if (f && !found.includes(f)) found.push(f)
    else if (!f && (note.attach ?? []).includes(n)) missing.push(n)
  }
  return { found, missing }
}

/** Test hook: register a file as if the user had added it. */
export const _rememberOriginalForTests = rememberOriginal

// ─── persistence ─────────────────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const s = useChat.getState()
    const data: Persisted & { pending: PendingTool[] } = {
      history: s.history,
      cards: s.cards,
      asks: s.asks,
      laterKept: s.laterKept,
      contextDay: s.contextDay,
      model: s.model,
      pending: s.pending,
    }
    if (isRepoReady()) void getStore().putKv(KV, data).catch(() => {})
  }, 300)
}

export async function loadChat(): Promise<void> {
  if (useChat.getState().loaded || !isRepoReady()) return
  const data = await getStore()
    .getKv<Persisted & { pending?: PendingTool[] }>(KV)
    .catch(() => undefined)
  useChat.setState({ ...empty, ...(data ?? {}), pending: data?.pending ?? [], loaded: true })
}

export function resetChat(): void {
  useChat.setState({ ...empty, pending: [], staged: [], live: '', error: null, busy: false })
  save()
}

// ─── display helpers ─────────────────────────────────────────────────────────────────

/** Text blocks the app adds for Claude only (world context, the hidden opener). */
export const isHiddenText = (t: string) => t.startsWith('[world]') || t.startsWith('[ui:')

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function worldContext(): string {
  const w = useWorld.getState()
  const s = w.settings
  return `[world] today: ${isoDay(Date.now())} · the world starts ${s ? isoDay(s.T0) : 'unknown'} · notes in the world: ${w.nodes.size}`
}

// ─── the loop ────────────────────────────────────────────────────────────────────────

function needsUser(p: PendingTool): boolean {
  return p.result === undefined && (p.name === 'propose_notes' || p.name === 'ask_user')
}

/** Tool results for the pending calls, from the cards and answers as they stand now. */
function toolResults(): Anthropic.ToolResultBlockParam[] {
  const { pending, cards, asks } = useChat.getState()
  return pending.map((p) => {
    if (p.result !== undefined) return { type: 'tool_result', tool_use_id: p.id, content: p.result, ...(p.isError ? { is_error: true } : {}) }
    if (p.name === 'propose_notes') {
      const cs = cards[p.id] ?? []
      const summary = {
        kept: cs.filter((c) => c.status === 'kept').map((c) => ({ key: c.key, id: c.id, title: c.note.title })),
        skipped: cs.filter((c) => c.status === 'skipped').map((c) => c.key),
        editRequests: cs.filter((c) => c.status === 'edit').map((c) => ({ key: c.key, instruction: c.instruction })),
        undecided: cs.filter((c) => c.status === 'open').map((c) => c.key),
      }
      return { type: 'tool_result', tool_use_id: p.id, content: JSON.stringify(summary) }
    }
    const a = asks[p.id]
    return { type: 'tool_result', tool_use_id: p.id, content: a?.answer ? `The user answered: ${a.answer}` : 'The user has not answered and moved on.' }
  })
}

/**
 * Send what the user has: pending tool results, staged files, pages for any links in the
 * text, notes kept since the last turn, and the text itself. Then run Claude's turn.
 */
export async function send(text = '', opts: { hidden?: boolean } = {}): Promise<void> {
  const s = useChat.getState()
  if (s.busy) return
  const trimmed = text.trim()
  useChat.setState({ busy: true, error: null })

  const content: ContentBlock[] = [...toolResults()]
  const today = isoDay(Date.now())
  if (s.contextDay !== today) content.push({ type: 'text', text: worldContext() })
  for (const item of s.staged) {
    content.push(...item.blocks)
    if (item.file) rememberOriginal(item.file)
  }
  const urls = [...new Set(trimmed.match(URL_RE) ?? [])].slice(0, 3)
  for (const url of urls) {
    const page = await urlToIntake(url)
    if ('error' in page) useChat.setState({ error: page.error })
    else content.push(...page.blocks)
  }
  if (s.laterKept.length) content.push({ type: 'text', text: `[ui:kept] Since then I also kept: ${s.laterKept.join('; ')}` })
  if (trimmed) content.push({ type: 'text', text: opts.hidden ? `[ui:start] ${trimmed}` : trimmed })
  if (!content.some((b) => b.type !== 'text' || !isHiddenText(b.text)) && !opts.hidden && !s.pending.length) {
    useChat.setState({ busy: false })
    return
  }

  useChat.setState((st) => ({
    history: [...st.history, { role: 'user', content }],
    pending: [],
    staged: [],
    laterKept: [],
    contextDay: today,
  }))
  save()
  await runTurns()
}

async function runTurns(): Promise<void> {
  try {
    for (let turn = 0; turn < AUTO_TURNS; turn++) {
      const done = await streamTurn()
      if (!done) return
      const { pending } = useChat.getState()
      if (!pending.length || pending.some(needsUser)) return
      // Only searches (or invalid calls): answer them and let Claude continue.
      useChat.setState((st) => ({ history: [...st.history, { role: 'user', content: toolResults() }], pending: [] }))
      save()
    }
  } finally {
    useChat.setState({ busy: false, live: '', toolHint: null })
    save()
  }
}

/** One assistant turn. Returns false when it ended in an error. */
async function streamTurn(): Promise<boolean> {
  useChat.setState({ live: '', toolHint: null })
  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: useChat.getState().history }),
    })
  } catch (e) {
    useChat.setState({ error: `Could not reach the app server: ${e instanceof Error ? e.message : String(e)}` })
    return false
  }
  if (res.status === 404) return useChat.setState({ error: 'The chat needs the dev server (npm run dev). Obsidian import and export still work.' }), false
  if (res.status === 503) return useChat.setState({ error: 'Add ANTHROPIC_API_KEY to .env.local and restart the dev server. Obsidian import and export still work.' }), false
  if (!res.ok || !res.body) return useChat.setState({ error: `The chat failed (${res.status}).` }), false

  let done: Extract<ChatStreamEvent, { t: 'done' }> | null = null
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done: eof } = await reader.read()
    if (value) buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const e = JSON.parse(line) as ChatStreamEvent
      if (e.t === 'text') useChat.setState((st) => ({ live: st.live + e.d }))
      else if (e.t === 'tool') useChat.setState({ toolHint: e.name })
      else if (e.t === 'error') useChat.setState({ error: e.message })
      else if (e.t === 'done') done = e
    }
    if (eof) break
  }
  if (!done) return false

  const content = done.content as Anthropic.ContentBlock[]
  useChat.setState((st) => ({
    model: done!.model,
    usage: {
      input: st.usage.input + done!.usage.input,
      output: st.usage.output + done!.usage.output,
      cacheRead: st.usage.cacheRead + done!.usage.cacheRead,
    },
  }))
  // A refusal before any output leaves nothing to append; the user's message stays and the
  // next one is appended after it (consecutive user turns are allowed).
  if (!content.length) return false
  useChat.setState((st) => ({ history: [...st.history, { role: 'assistant', content: content as unknown as ContentBlock[] }], live: '' }))

  const truncated = done.stopReason === 'max_tokens'
  const pending: PendingTool[] = []
  const cards: Record<string, Card[]> = {}
  const asks: Record<string, Ask> = {}
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    const name = block.name as ToolName
    if (truncated) {
      pending.push({ id: block.id, name, result: 'The call was cut off before its input finished. Propose fewer or shorter notes at a time.', isError: true })
      continue
    }
    const schema = TOOL_INPUTS[name]
    const parsed = schema?.safeParse(block.input)
    if (!schema || !parsed?.success) {
      pending.push({ id: block.id, name, result: `Invalid input: ${parsed?.error?.issues[0]?.message ?? `unknown tool ${name}`}`, isError: true })
      continue
    }
    if (name === 'search_world') {
      const q = parsed.data as { query: string; limit?: number }
      pending.push({ id: block.id, name, result: JSON.stringify(await searchWorld(q.query, q.limit)) })
    } else if (name === 'propose_notes') {
      cards[block.id] = (parsed.data as { notes: ProposedNote[] }).notes.map((note) => ({ key: note.key, note, status: 'open' }))
      pending.push({ id: block.id, name })
    } else {
      asks[block.id] = { input: parsed.data as AskUserInput }
      pending.push({ id: block.id, name })
    }
  }
  useChat.setState((st) => ({ pending, cards: { ...st.cards, ...cards }, asks: { ...st.asks, ...asks } }))
  return true
}

/** When every pending call has the user's decision, continue without waiting for text. */
function continueIfDecided(): void {
  const s = useChat.getState()
  if (s.busy || !s.pending.length) return
  const decided = s.pending.every((p) => {
    if (p.result !== undefined) return true
    if (p.name === 'ask_user') return !!s.asks[p.id]?.answer
    return (s.cards[p.id] ?? []).every((c) => c.status !== 'open')
  })
  if (decided) void send()
}

// ─── decisions ───────────────────────────────────────────────────────────────────────

function isPending(toolId: string): boolean {
  return useChat.getState().pending.some((p) => p.id === toolId)
}

function setCard(toolId: string, key: string, patch: Partial<Card>): void {
  useChat.setState((st) => ({ cards: { ...st.cards, [toolId]: (st.cards[toolId] ?? []).map((c) => (c.key === key ? { ...c, ...patch } : c)) } }))
  save()
}

/** Keep some of a call's open cards as one undoable step; links between them resolve. */
async function keepCards(toolId: string, keys: readonly string[]): Promise<void> {
  const settings = useWorld.getState().settings
  if (!settings) return
  const cs = useChat.getState().cards[toolId] ?? []
  const open = cs.filter((c) => keys.includes(c.key) && c.status === 'open')
  if (!open.length) return
  const now = Date.now()
  // Additions to existing notes: files, embeds and links go onto that note.
  for (const c of open.filter((x) => x.note.addTo && useWorld.getState().nodes.has(x.note.addTo))) {
    const id = c.note.addTo!
    try {
      const target = useWorld.getState().nodes.get(id)!
      const extra = proposalToDraft(c.note, id, new Map([...useWorld.getState().nodes.keys()].map((k) => [k, k])), settings, now, useChat.getState().model ?? 'claude')
      if (extra.embeds?.length) await updateNode(id, { embeds: [...(target.embeds ?? []), ...extra.embeds] }, { keepAnchor: true })
      for (const l of extra.links ?? []) if (!target.links.some((x) => x.targetId === l.targetId)) await link(id, l.targetId, l.kind).catch(() => {})
      const { found, missing } = originalsFor(c.note)
      const failed = [...missing]
      for (const f of found) await addAttachment(id, f, f.name).catch(() => failed.push(f.name))
      setCard(toolId, c.key, { status: 'kept', id, error: failed.length ? `Not attached (add ${failed.length === 1 ? 'it' : 'them'} again): ${failed.join(', ')}` : undefined })
    } catch (e) {
      setCard(toolId, c.key, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const chosen = open.filter((x) => !(x.note.addTo && useWorld.getState().nodes.has(x.note.addTo)))
  if (!chosen.length) return continueIfDecided()
  const ids = new Map<string, string>()
  for (const id of useWorld.getState().nodes.keys()) ids.set(id, id)
  for (const c of cs) if (c.status === 'kept' && c.id) ids.set(c.key, c.id)
  const fresh = new Map(chosen.map((c) => [c.key, crypto.randomUUID()]))
  for (const [k, id] of fresh) ids.set(k, id)
  const model = useChat.getState().model ?? 'claude'
  try {
    const drafts = chosen.map((c) => proposalToDraft(c.note, fresh.get(c.key)!, ids, settings, now, model))
    await addNodes(drafts, { label: drafts.length === 1 ? `Kept ${drafts[0].title}` : `Kept ${drafts.length} notes` })
  } catch (e) {
    for (const c of chosen) setCard(toolId, c.key, { error: e instanceof Error ? e.message : String(e) })
    return
  }
  for (const c of chosen) {
    const id = fresh.get(c.key)!
    const { found, missing } = originalsFor(c.note)
    const failed: string[] = [...missing]
    for (const f of found) await addAttachment(id, f, f.name).catch(() => failed.push(f.name))
    setCard(toolId, c.key, {
      status: 'kept',
      id,
      error: failed.length ? `Not attached (add ${failed.length === 1 ? 'it' : 'them'} again to keep the original): ${failed.join(', ')}` : undefined,
    })
  }
  // Cards kept earlier that link to the ones just kept get their links now.
  for (const c of cs) {
    if (c.status !== 'kept' || !c.id) continue
    for (const l of c.note.links) {
      const target = fresh.get(l.to)
      if (target) await link(c.id, target, l.kind).catch(() => {})
    }
  }
  if (!isPending(toolId)) {
    useChat.setState((st) => ({ laterKept: [...st.laterKept, ...chosen.map((c) => `${c.note.title} (${fresh.get(c.key)})`)] }))
    save()
  }
  continueIfDecided()
}

export const keepCard = (toolId: string, key: string) => keepCards(toolId, [key])
export const keepAll = (toolId: string) =>
  keepCards(
    toolId,
    (useChat.getState().cards[toolId] ?? []).filter((c) => c.status === 'open').map((c) => c.key),
  )

export function skipCard(toolId: string, key: string): void {
  setCard(toolId, key, { status: 'skipped' })
  continueIfDecided()
}

/** Ask Claude to change a proposal ("make it 2019", "merge with X"): sent at once. */
export function editCard(toolId: string, key: string, instruction: string): void {
  if (!instruction.trim()) return
  setCard(toolId, key, { status: 'edit', instruction: instruction.trim() })
  if (isPending(toolId)) void send()
  else void send(`About "${useChat.getState().cards[toolId]?.find((c) => c.key === key)?.note.title}": ${instruction.trim()}`)
}

export function answerAsk(toolId: string, answer: string): void {
  useChat.setState((st) => ({ asks: { ...st.asks, [toolId]: { ...st.asks[toolId], answer } } }))
  save()
  continueIfDecided()
}

// ─── staging ─────────────────────────────────────────────────────────────────────────

export function stage(items: readonly IntakeItem[]): void {
  useChat.setState((st) => ({ staged: [...st.staged, ...items] }))
}

export function unstage(index: number): void {
  useChat.setState((st) => ({ staged: st.staged.filter((_, i) => i !== index) }))
}

/** Start the interview when there is no conversation yet. */
export function startInterview(): void {
  const s = useChat.getState()
  if (s.history.length || s.busy) return
  void send('I just opened Worldview for the first time.', { hidden: true })
}

registerDevApi('chat', () => useChat.getState())
