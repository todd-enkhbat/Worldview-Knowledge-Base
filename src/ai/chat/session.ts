import type Anthropic from '@anthropic-ai/sdk'
import { create } from 'zustand'
import { useWorld } from '../../app/store.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { addAttachment, addNodes, getStore, isRepoReady, link, putWorldState, subscribeRepo, updateNode, useRepoStatus } from '../../data/repo.ts'
import type { WorldStore } from '../../data/WorldStore.ts'
import { recordUsage } from '../usage.ts'
import { findOriginal, rememberOriginal } from './originals.ts'
import { citationAllowed, evidenceFilters, evidenceScope, proposalToDraft, readPassageForModel, readMemoryContextForModel, readRecord, searchPassagesForModel, searchWorld, stagedProposal, URL_RE, urlToIntake, type EvidenceCitation, type IntakeItem } from './apply.ts'
import { TOOL_INPUTS, type AskUserInput, type ChatStreamEvent, type ProposedNote, type ReadRecordInput, type ToolName } from './protocol.ts'
import { initializeKnowledge, useKnowledge } from '../../knowledge/index.ts'

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
  /** Only citations issued by an actual evidence tool may become clickable sources. */
  citations: Record<string, EvidenceCitation>
  /** Old local transcript stays visible when permissions or source scope changes. */
  modelHistoryStart: number
  evidenceBoundary: string
}

export interface ChatState extends Persisted {
  cloudAi: 'unknown' | 'disabled' | 'enabled'
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
  intakeBusy: boolean
  usage: { input: number; output: number; cacheRead: number }
}

const KV = 'chat.v1'
const AUTO_TURNS = 6

const empty: Persisted = { history: [], cards: {}, asks: {}, laterKept: [], contextDay: null, model: null, citations: {}, modelHistoryStart: 0, evidenceBoundary: '' }

export const useChat = create<ChatState>()(() => ({
  ...empty,
  cloudAi: 'unknown',
  loaded: false,
  busy: false,
  live: '',
  toolHint: null,
  error: null,
  pending: [],
  staged: [],
  intakeBusy: false,
  usage: { input: 0, output: 0, cacheRead: 0 },
}))

// ─── originals ───────────────────────────────────────────────────────────────────────
// Files the user added, by name (originals.ts: memory plus browser storage, so a card kept
// after a reload still gets its file).

/** The originals a proposal should keep: its attach list, plus its source if that is a file. */
async function originalsFor(note: ProposedNote): Promise<{ found: File[]; missing: string[] }> {
  const names = [...new Set([...(note.attach ?? []), ...(note.source.ref && !/^https?:\/\//.test(note.source.ref) ? [note.source.ref] : [])])]
  const found: File[] = []
  const missing: string[] = []
  for (const n of names) {
    const f = await findOriginal(n)
    if (f && !found.includes(f)) found.push(f)
    else if (!f && (note.attach ?? []).includes(n)) missing.push(n)
  }
  return { found, missing }
}

/** Test hook: register a file as if the user had added it. */
export const _rememberOriginalForTests = rememberOriginal

// ─── persistence ─────────────────────────────────────────────────────────────────────

let loadedStore: WorldStore | null = null
let pendingSave: Promise<void> = Promise.resolve()
let sessionGeneration = 0
let streamController: AbortController | null = null
let streamReader: ReadableStreamDefaultReader<string> | null = null
let statusRequest: Promise<boolean> | null = null
interface ChatScope { generation: number; store: WorldStore }

export function setCloudAiStatus(status: { provider: unknown; configured: unknown }): void {
  const enabled = (status.provider === 'openai' || status.provider === 'anthropic') && status.configured === true
  useChat.setState({ cloudAi: enabled ? 'enabled' : 'disabled' })
  if (!enabled) {
    streamController?.abort()
    void streamReader?.cancel().catch(() => {})
  }
}

/** Read only the local configuration. Never probes a provider or sends source text. */
export async function refreshCloudAiStatus(): Promise<boolean> {
  if (!isRepoReady()) return false
  if (statusRequest) return statusRequest
  const scope = currentScope()
  statusRequest = (async () => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch('/api/ai/status', { headers: { 'x-wv-client': 'worldview-ai-status' }, signal: controller.signal })
      if (!response.ok) throw new Error('Local AI status is unavailable.')
      const value: unknown = await response.json()
      if (!scope || !scopeCurrent(scope)) return false
      setCloudAiStatus(value && typeof value === 'object' ? value as { provider: unknown; configured: unknown } : { provider: null, configured: false })
      return useChat.getState().cloudAi === 'enabled'
    } catch {
      if (scope && scopeCurrent(scope)) setCloudAiStatus({ provider: null, configured: false })
      return false
    } finally { clearTimeout(timeout) }
  })()
  try { return await statusRequest } finally { statusRequest = null }
}

export function chatSessionToken(): number { return sessionGeneration }
export function isChatSessionTokenCurrent(token: number): boolean { return token === sessionGeneration && isRepoReady() }

function currentScope(): ChatScope | null {
  if (!isRepoReady()) return null
  const store = getStore()
  if (loadedStore && loadedStore !== store) invalidateChat()
  return { generation: sessionGeneration, store }
}

function scopeCurrent(scope: ChatScope): boolean {
  return scope.generation === sessionGeneration && isRepoReady() && getStore() === scope.store
}

/** Clearing in-memory state must never write over a newly restored transcript. */
function invalidateChat(preserveStaged = false): void {
  sessionGeneration++
  streamController?.abort()
  streamController = null
  void streamReader?.cancel().catch(() => {})
  streamReader = null
  loadedStore = null
  statusRequest = null
  const staged = preserveStaged ? useChat.getState().staged : []
  useChat.setState({ ...empty, cloudAi: 'unknown', loaded: false, pending: [], staged, intakeBusy: false, live: '', toolHint: null, error: null, busy: false, usage: { input: 0, output: 0, cacheRead: 0 } })
}

const unsubscribeTranscript = subscribeRepo((change, origin) => {
  if (change.type !== 'wipe' && change.type !== 'import' && !(origin === 'remote' && change.type === 'kv' && change.keys.includes(KV))) return
  invalidateChat(origin === 'remote' && change.type === 'kv')
  const scope = currentScope()
  if (scope) void loadChat().catch((error: unknown) => { if (scopeCurrent(scope)) useChat.setState({ error: `Could not reload the restored conversation: ${error instanceof Error ? error.message : String(error)}` }) })
})
const unsubscribeTranscriptStatus = useRepoStatus.subscribe((next, previous) => { if (previous.ready && !next.ready) invalidateChat() })
import.meta.hot?.dispose(() => { unsubscribeTranscript(); unsubscribeTranscriptStatus(); invalidateChat() })

function save(scope = currentScope()): void {
  if (!scope || !scopeCurrent(scope)) return
  if (!isRepoReady()) return
  const target = scope.store
  const s = useChat.getState()
  const data: Persisted & { pending: PendingTool[] } = {
    history: s.history,
    cards: s.cards,
    asks: s.asks,
    laterKept: s.laterKept,
    contextDay: s.contextDay,
    model: s.model,
    citations: s.citations,
    modelHistoryStart: s.modelHistoryStart,
    evidenceBoundary: s.evidenceBoundary,
    pending: s.pending,
  }
  // The repository queue also owns backups and closeRepo, so neither can overtake a
  // transcript save. No timer may later write one account's chat into another store.
  pendingSave = putWorldState(KV, data, { store: target, shouldWrite: () => scopeCurrent(scope) }).catch((e: unknown) => {
    if (scopeCurrent(scope)) useChat.setState({ error: `The chat could not be saved. ${e instanceof Error ? e.message : String(e)}` })
  })
}

export async function loadChat(): Promise<void> {
  const scope = currentScope()
  if (!scope) return
  const target = scope.store
  if (useChat.getState().loaded && loadedStore === target) return
  await pendingSave
  const data = await target
    .getKv<Persisted & { pending?: PendingTool[] }>(KV)
    .catch(() => undefined)
  if (!scopeCurrent(scope)) return
  const history = data?.history ?? []
  const citations = data?.citations && typeof data.citations === 'object' && !Array.isArray(data.citations) ? Object.fromEntries(Object.entries(data.citations).filter(([url, citation]) => citation && typeof citation === 'object' && citation.citationUrl === url && url.startsWith('#/library?') && typeof citation.title === 'string').slice(-1000)) : {}
  const modelHistoryStart = Number.isInteger(data?.modelHistoryStart) ? Math.max(0, Math.min(history.length, data!.modelHistoryStart)) : 0
  useChat.setState({ ...empty, ...(data ?? {}), history, citations, modelHistoryStart, evidenceBoundary: typeof data?.evidenceBoundary === 'string' ? data.evidenceBoundary : '', pending: data?.pending ?? [], loaded: true })
  loadedStore = target
}

export function resetChat(): void {
  invalidateChat()
  save()
}

// ─── display helpers ─────────────────────────────────────────────────────────────────

/** Text blocks the app adds for Claude only (world context, the hidden opener). */
export const isHiddenText = (t: string) => t.startsWith('[world]') || t.startsWith('[ui:')

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function worldContext(): string {
  const w = useWorld.getState()
  const s = w.settings
  const scope = evidenceScope()
  return `[world] today: ${isoDay(Date.now())} · the world starts ${s ? isoDay(s.T0) : 'unknown'} · notes in the world: ${w.nodes.size} · source scope: ${scope.length ? scope.join(', ') : 'all permitted sources'} · investigation filters: ${JSON.stringify(evidenceFilters())}`
}

function evidenceBoundary(): string {
  const denied = useKnowledge.getState().sources.filter((s) => s.excluded || s.deleted || !s.aiAllowed).map((s) => s.id).sort()
  const stale = Object.values(useChat.getState().citations).filter((c) => !citationAllowed(c)).map((c) => c.citationUrl).sort()
  return JSON.stringify([evidenceFilters(), denied, stale])
}

function retainEvidence(result: unknown): void {
  const values = Array.isArray(result) ? result : result && typeof result === 'object' && 'evidence' in result && Array.isArray(result.evidence) ? result.evidence : [result]
  const citations: Record<string, EvidenceCitation> = {}
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const r = value as Record<string, unknown>
    if (r.ok === false || typeof r.citationUrl !== 'string' || typeof r.title !== 'string' || typeof r.id !== 'string') continue
    const passage = typeof r.sourceId === 'string' && typeof r.versionId === 'string'
    const citation: EvidenceCitation = {
      citationUrl: r.citationUrl,
      title: r.title,
      ...(passage ? { sourceId: String(r.sourceId), passageId: r.id, versionId: String(r.versionId) } : {}),
      ...(typeof r.nodeId === 'string' ? { nodeId: r.nodeId } : !passage ? { nodeId: r.id } : {}),
      ...(typeof r.digest === 'string' ? { digest: r.digest } : {}),
      ...(typeof r.updatedAt === 'number' ? { updatedAt: r.updatedAt } : {}),
    }
    if (citationAllowed(citation)) citations[citation.citationUrl] = citation
  }
  if (Object.keys(citations).length) useChat.setState((s) => ({ citations: { ...s.citations, ...citations } }))
}

/** Keep the durable transcript while bounding provider context at a valid user-turn boundary. */
function modelMessages(): MessageParam[] {
  const state = useChat.getState()
  let start = state.modelHistoryStart
  if (state.history.length - start > 360) {
    const candidate = state.history.findIndex((message, index) => index >= state.history.length - 300 && message.role === 'user' && (typeof message.content === 'string' || message.content.some((block) => block.type !== 'tool_result' && (block.type !== 'text' || !isHiddenText(block.text)))))
    if (candidate >= 0) {
      start = candidate
      useChat.setState({ modelHistoryStart: start })
    }
  }
  const messages = state.history.slice(start)
  if (start > 0 && messages[0]?.role === 'user') {
    // A resumed user turn may also carry results for an earlier assistant call; that
    // earlier call is no longer in context, so only its visible new input is retained.
    const content = typeof messages[0].content === 'string' ? [{ type: 'text' as const, text: messages[0].content }] : messages[0].content.filter((block) => block.type !== 'tool_result')
    messages[0] = { role: 'user', content: [{ type: 'text', text: worldContext() }, ...content] }
  }
  return messages
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
  const scope = currentScope()
  if (!scope) return
  let s = useChat.getState()
  if (s.busy) return
  if (s.cloudAi === 'unknown') await refreshCloudAiStatus()
  if (!scopeCurrent(scope)) return
  if (useChat.getState().cloudAi !== 'enabled') {
    useChat.setState({ error: 'Cloud AI is off. Save your words and files to your world, or enable a provider later in Settings.' })
    return
  }
  useChat.setState({ busy: true, error: null })
  // A previous tool result or answer may quote newly excluded content. Keep the visible
  // local transcript, but never resend it across a changed permission/scope boundary.
  try {
    await initializeKnowledge()
    if (!scopeCurrent(scope)) return
    await loadChat()
    if (!scopeCurrent(scope)) return
    s = useChat.getState()
  } catch (e) {
    if (scopeCurrent(scope)) useChat.setState({ busy: false, error: `The source record could not be opened. ${e instanceof Error ? e.message : String(e)}` })
    return
  }
  const boundary = evidenceBoundary()
  if (s.evidenceBoundary !== boundary) {
    useChat.setState({ modelHistoryStart: s.history.length, evidenceBoundary: boundary, pending: [], contextDay: null })
    s = useChat.getState()
  }
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
    if (!scopeCurrent(scope)) return
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
  if (!scopeCurrent(scope)) return
  save(scope)
  await runTurns(scope)
  // A missing key or broken connection must not consume the only visible copy of a
  // dropped file. Keep it available for the local save path and for another attempt.
  if (scopeCurrent(scope) && useChat.getState().error && s.staged.length) {
    useChat.setState((st) => ({ staged: [...s.staged.filter((item) => !st.staged.includes(item)), ...st.staged] }))
  }
}

async function runTurns(scope: ChatScope): Promise<void> {
  try {
    for (let turn = 0; turn < AUTO_TURNS; turn++) {
      if (!scopeCurrent(scope)) return
      const done = await streamTurn(scope)
      if (!scopeCurrent(scope)) return
      if (!done) return
      const { pending } = useChat.getState()
      if (!pending.length || pending.some(needsUser)) return
      // Only searches (or invalid calls): answer them and let Claude continue.
      useChat.setState((st) => ({ history: [...st.history, { role: 'user', content: toolResults() }], pending: [] }))
      save(scope)
    }
  } catch (e) {
    if (scopeCurrent(scope)) useChat.setState({ error: `The reply was interrupted. Your message is still here. ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    if (scopeCurrent(scope)) {
      useChat.setState({ busy: false, live: '', toolHint: null })
      save(scope)
    }
  }
}

/** One assistant turn. Returns false when it ended in an error. */
async function streamTurn(scope: ChatScope): Promise<boolean> {
  if (!scopeCurrent(scope)) return false
  if (useChat.getState().cloudAi !== 'enabled') return false
  useChat.setState({ live: '', toolHint: null })
  let res: Response
  const boundary = evidenceBoundary()
  if (boundary !== useChat.getState().evidenceBoundary) {
    useChat.setState({ error: 'Source permissions or the selected investigation changed. Ask again to start a fresh AI context; your local transcript is preserved.' })
    return false
  }
  try {
    const controller = new AbortController()
    streamController = controller
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: modelMessages() }),
      signal: controller.signal,
    })
  } catch (e) {
    if (scopeCurrent(scope)) useChat.setState({ error: `Could not reach the app server: ${e instanceof Error ? e.message : String(e)}` })
    return false
  }
  if (!scopeCurrent(scope)) { await res.body?.cancel().catch(() => {}); return false }
  if (res.status === 404) return useChat.setState({ error: 'The chat needs the dev server (npm run dev). Obsidian import and export still work.' }), false
  if (res.status === 503) return useChat.setState({ cloudAi: 'disabled', error: 'Cloud AI is not configured for this world. Your draft and files are safe. Save them to your world; imports and exports work without AI.' }), false
  if (!res.ok || !res.body) return useChat.setState({ error: `The chat failed (${res.status}).` }), false

  let done: Extract<ChatStreamEvent, { t: 'done' }> | null = null
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  streamReader = reader
  let buf = ''
  try {
    for (;;) {
      const { value, done: eof } = await reader.read()
      if (!scopeCurrent(scope)) return false
      if (value) buf += value
      if (eof && buf.trim()) buf += '\n'
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
  } finally { if (streamReader === reader) streamReader = null; reader.releaseLock() }
  if (!scopeCurrent(scope)) return false
  if (!done) {
    if (!useChat.getState().error) useChat.setState({ error: 'The reply was interrupted. Your message and original files are still here; try again or save them directly.' })
    return false
  }

  const content = done.content as Anthropic.ContentBlock[]
  if (evidenceBoundary() !== boundary) {
    useChat.setState({ error: 'Source permissions or the selected investigation changed during the reply. Ask again; your local transcript is preserved.' })
    return false
  }
  void recordUsage(done.model, done.usage)
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

  // A provider can refuse a response that also contains partial tool calls. Keep the
  // transcript, execute none of those calls, and start fresh provider context next turn
  // so an unanswered refused call cannot invalidate the following request.
  if (done.stopReason === 'refusal') {
    useChat.setState((st) => ({ pending: [], modelHistoryStart: st.history.length, error: st.error ?? 'The AI provider declined to continue this request.' }))
    return false
  }

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
    if (name === 'read_memory_context') {
      const q = parsed.data as { query: string; maxBytes?: number }
      const result = await readMemoryContextForModel(q.query, q.maxBytes)
      if (!scopeCurrent(scope)) return false
      retainEvidence(result)
      pending.push({ id: block.id, name, result: result.rendered })
    } else if (name === 'search_world') {
      const q = parsed.data as { query: string; limit?: number }
      const result = await searchWorld(q.query, q.limit)
      if (!scopeCurrent(scope)) return false
      retainEvidence(result)
      pending.push({ id: block.id, name, result: JSON.stringify(result) })
    } else if (name === 'read_record') {
      const result = await readRecord(parsed.data as ReadRecordInput)
      if (!scopeCurrent(scope)) return false
      retainEvidence(result)
      pending.push({ id: block.id, name, result: JSON.stringify(result), ...(!result.ok ? { isError: true } : {}) })
    } else if (name === 'search_passages') {
      const q = parsed.data as { query: string; limit?: number }
      const result = await searchPassagesForModel(q.query, q.limit)
      if (!scopeCurrent(scope)) return false
      retainEvidence(result)
      pending.push({ id: block.id, name, result: JSON.stringify(result) })
    } else if (name === 'read_passage') {
      const result = await readPassageForModel((parsed.data as { id: string }).id)
      if (!scopeCurrent(scope)) return false
      retainEvidence(result)
      pending.push({ id: block.id, name, result: JSON.stringify(result), ...(!result.ok ? { isError: true } : {}) })
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
  if (s.busy || s.cloudAi !== 'enabled' || !s.pending.length) return
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
  if (!useChat.getState().cards[toolId]?.some((card) => card.key === key)) return
  useChat.setState((st) => ({ cards: { ...st.cards, [toolId]: (st.cards[toolId] ?? []).map((c) => (c.key === key ? { ...c, ...patch } : c)) } }))
  save()
}

/** Keep some of a call's open cards as one undoable step; links between them resolve. */
async function keepCards(toolId: string, keys: readonly string[]): Promise<void> {
  const scope = currentScope()
  if (!scope) return
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
      if (!scopeCurrent(scope)) return
      for (const l of extra.links ?? []) {
        if (!scopeCurrent(scope)) return
        if (!target.links.some((x) => x.targetId === l.targetId)) await link(id, l.targetId, l.kind).catch(() => {})
      }
      const { found, missing } = await originalsFor(c.note)
      if (!scopeCurrent(scope)) return
      const failed = [...missing]
      for (const f of found) { if (!scopeCurrent(scope)) return; await addAttachment(id, f, f.name).catch(() => failed.push(f.name)) }
      if (!scopeCurrent(scope)) return
      setCard(toolId, c.key, { status: 'kept', id, error: failed.length ? `Not attached (add ${failed.length === 1 ? 'it' : 'them'} again): ${failed.join(', ')}` : undefined })
    } catch (e) {
      if (scopeCurrent(scope)) setCard(toolId, c.key, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const chosen = open.filter((x) => !(x.note.addTo && useWorld.getState().nodes.has(x.note.addTo)))
  if (!scopeCurrent(scope)) return
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
    if (!scopeCurrent(scope)) return
  } catch (e) {
    if (scopeCurrent(scope)) for (const c of chosen) setCard(toolId, c.key, { error: e instanceof Error ? e.message : String(e) })
    return
  }
  for (const c of chosen) {
    const id = fresh.get(c.key)!
    const { found, missing } = await originalsFor(c.note)
    if (!scopeCurrent(scope)) return
    const failed: string[] = [...missing]
    for (const f of found) { if (!scopeCurrent(scope)) return; await addAttachment(id, f, f.name).catch(() => failed.push(f.name)) }
    if (!scopeCurrent(scope)) return
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
      if (!scopeCurrent(scope)) return
    }
  }
  if (!isPending(toolId)) {
    useChat.setState((st) => ({ laterKept: [...st.laterKept, ...chosen.map((c) => `${c.note.title} (${fresh.get(c.key)})`)] }))
    save(scope)
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

/**
 * Keep the staged files and links as notes as they are, one each, without Claude (nothing is
 * sent anywhere). One undoable step; the originals are attached. Returns how many were kept.
 */
export async function keepStaged(): Promise<number> {
  const scope = currentScope()
  if (!scope) return 0
  const settings = useWorld.getState().settings
  const staged = useChat.getState().staged
  const now = Date.now()
  const kept = staged.flatMap((item, k) => {
    const note = stagedProposal(item, `s${k}`, now)
    return note ? [{ item, note, id: crypto.randomUUID() }] : []
  })
  if (!settings || !kept.length) return 0
  useChat.setState({ error: null })
  try {
    const drafts = kept.map((k) => proposalToDraft(k.note, k.id, new Map(), settings, now, 'none'))
    await addNodes(drafts, { label: drafts.length === 1 ? `Kept ${drafts[0].title}` : `Kept ${drafts.length} files` })
    if (!scopeCurrent(scope)) return 0
  } catch (e) {
    if (scopeCurrent(scope)) useChat.setState({ error: e instanceof Error ? e.message : String(e) })
    return 0
  }
  const failed: string[] = []
  for (const k of kept) {
    if (!scopeCurrent(scope)) return 0
    if (k.item.file) await addAttachment(k.id, k.item.file, k.item.file.name).catch(() => failed.push(k.item.name))
  }
  if (!scopeCurrent(scope)) return 0
  const done = new Set(kept.map((k) => k.item))
  useChat.setState((st) => ({
    staged: st.staged.filter((i) => !done.has(i)),
    error: failed.length ? `Not attached (add ${failed.length === 1 ? 'it' : 'them'} again): ${failed.join(', ')}` : null,
  }))
  return kept.length
}

/** A deliberate local capture: preserve the user's words and originals without an AI request. */
export async function saveThought(text: string, opts: { reflection?: boolean } = {}): Promise<string | null> {
  const scope = currentScope()
  if (!scope) return null
  const body = text.trim()
  if (!body) {
    await keepStaged()
    return null
  }
  const settings = useWorld.getState().settings
  if (!settings || useChat.getState().busy) return null
  const now = Date.now()
  const staged = useChat.getState().staged.filter((item) => item.file || item.url)
  const urls = [...new Set([...(body.match(URL_RE) ?? []), ...staged.flatMap((item) => item.url ? [item.url] : [])])]
  const id = crypto.randomUUID()
  const title = body.split('\n').find((line) => line.trim())!.replace(/^#+\s*/, '').slice(0, 100)
  const proposal: ProposedNote = {
    key: id,
    kind: opts.reflection ? 'memory' : 'idea',
    title,
    body,
    date: { iso: isoDay(now), precision: 'day', certain: true },
    tags: [...new Set([...(opts.reflection ? ['reflection'] : []), ...Array.from(body.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu), (m) => m[1].toLowerCase())])],
    links: [],
    source: {},
    embeds: urls.map((url) => ({ kind: /(?:youtube\.com|youtu\.be)/.test(url) ? 'youtube' as const : 'web' as const, url })),
  }
  useChat.setState({ busy: true, error: null })
  try {
    const draft = proposalToDraft(proposal, id, new Map(), settings, now, 'none')
    await addNodes([draft], { label: opts.reflection ? 'Saved daily reflection' : 'Saved thought' })
    if (!scopeCurrent(scope)) return null
    const failed = new Set<IntakeItem>()
    for (const item of staged) {
      if (!scopeCurrent(scope)) return null
      if (item.file) {
        try { await addAttachment(id, item.file, item.file.name) } catch { failed.add(item) }
      }
    }
    if (!scopeCurrent(scope)) return null
    useChat.setState((st) => ({
      staged: st.staged.filter((item) => !staged.includes(item) || failed.has(item)),
      error: failed.size ? 'Your thought was saved. Some files could not be attached; they are still staged so you can try again.' : null,
      laterKept: [...st.laterKept, `${title} (${id})`],
    }))
    save(scope)
    return id
  } catch (e) {
    if (scopeCurrent(scope)) useChat.setState({ error: `Could not save: ${e instanceof Error ? e.message : String(e)}` })
    return null
  } finally {
    if (scopeCurrent(scope)) useChat.setState({ busy: false })
  }
}

/** Start the interview when there is no conversation yet. */
export function startInterview(): void {
  const s = useChat.getState()
  if (s.history.length || s.busy || s.cloudAi !== 'enabled') return
  void send('I just opened Worldview for the first time.', { hidden: true })
}

registerDevApi('chat', () => useChat.getState())
