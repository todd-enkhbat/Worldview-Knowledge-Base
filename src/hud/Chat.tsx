import { ArrowUp, ArrowUpRight, CheckCircle, Notebook, Paperclip, Sparkle, X } from '@phosphor-icons/react'
import './Chat.css'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type Anthropic from '@anthropic-ai/sdk'
import { useApp, useWorld } from '../app/store.ts'
import { getStore, useRepoStatus } from '../data/repo.ts'
import { exportVault, vaultAttachments, zipVault } from '../data/obsidian.ts'
import {
  answerAsk,
  editCard,
  isHiddenText,
  keepAll,
  keepCard,
  loadChat,
  refreshCloudAiStatus,
  send,
  skipCard,
  saveThought,
  unstage,
  keepStaged,
  useChat,
  type Card,
} from '../ai/chat/session.ts'
import { BTN, BTN_PRIMARY } from './DurabilityKit.tsx'
import { Markdown } from './markdown.ts'
import { entriesOf, intake, intakeFolderFiles } from './chatIntake.ts'
import { selectAndFly } from './shortcuts.ts'
import { openAgentsPanel } from '../world/agents/model.ts'
import { citationAllowed, type EvidenceCitation } from '../ai/chat/apply.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { openWorkspaceRecord, QUICK_CAPTURE_DRAFT_LIMIT, setQuickCaptureDraft as setText, useWorkspace } from '../workspace/state.ts'
import { promoteAnswer } from '../knowledge/artifacts/index.ts'

// Capture stays available beside the world. Direct saves preserve the user's words and
// originals locally; AI turns propose reviewable records. "/" opens the conversation.

type Block = Anthropic.ContentBlockParam | Anthropic.ContentBlock

const KIND_LABEL: Record<string, string> = { idea: 'Idea', entity: 'Entity', lens: 'Lens', document: 'Document', memory: 'Memory', demon: 'Demon' }

function blocksOf(content: unknown): Block[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : (content as Block[])
}

/** A short chip for an attachment block in a user turn, or null for plain text. */
function chipOf(b: Block): string | null {
  if (b.type === 'document') return `PDF · ${(b as { title?: string }).title ?? 'document'}`
  if (b.type === 'image') return 'Image'
  if (b.type === 'text') {
    const file = /^<file name=("[^"]*")/.exec(b.text)
    if (file) return `File · ${JSON.parse(file[1]) as string}`
    const page = /^<(page|video) url=("[^"]*") title=("[^"]*")/.exec(b.text)
    if (page) return `${page[1] === 'video' ? 'Video' : 'Page'} · ${JSON.parse(page[3]) as string}`
    const folder = /^<folder name=("[^"]*")/.exec(b.text)
    if (folder) return `Folder · ${JSON.parse(folder[1]) as string}`
    if (b.text.startsWith('[ui:imported]')) return 'Obsidian vault imported'
  }
  return null
}

function CardView({ toolId, card, writer }: { toolId: string; card: Card; writer: boolean }) {
  const cloudEnabled = useChat((s) => s.cloudAi === 'enabled')
  const [editing, setEditing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const n = card.note
  const open = card.status === 'open'
  const onKey = (e: ReactKeyboardEvent) => {
    if (!open || !writer || e.target !== e.currentTarget) return
    if (e.key === 'k') void keepCard(toolId, card.key)
    else if (e.key === 's') skipCard(toolId, card.key)
    else if (e.key === 'e' && cloudEnabled) setEditing(true)
  }
  return (
    <li
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Proposed ${KIND_LABEL[n.kind] ?? n.kind}: ${n.title}`}
      className={`chat-proposal border px-3 py-2 outline-none focus-visible:border-ember ${card.status === 'kept' ? 'border-ember/50 bg-ember/5' : card.status === 'open' ? 'border-bone/25' : 'border-bone/10 opacity-60'}`}
    >
      <div className="hud-label flex items-center gap-2">
        <span>{KIND_LABEL[n.kind] ?? n.kind}</span>
        <span>·</span>
        <span title={n.date.certain ? 'Date given' : 'Date inferred: check it'}>
          {n.date.iso}
          {n.date.certain ? '' : ' ?'}
        </span>
        {card.status !== 'open' && <span className="ml-auto text-ember">{card.status === 'edit' ? 'change asked' : card.status}</span>}
      </div>
      {n.addTo && (
        <div className="mt-0.5 text-[11px] text-ember">
          Adds to <AddToTitle id={n.addTo} />
        </div>
      )}
      <div className="mt-0.5 text-[13px] font-semibold text-bone">
        {card.status === 'kept' && card.id ? (
          <button type="button" className="text-left hover:underline" onClick={() => selectAndFly(card.id!)}>
            {n.title}
          </button>
        ) : (
          n.title
        )}
      </div>
      {n.body && <p className="mt-1 line-clamp-3 whitespace-pre-line text-[12px] leading-snug text-bone/80">{n.body}</p>}
      {(n.tags.length > 0 || n.links.length > 0 || n.source.ref || n.attach?.length || n.embeds?.length) && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-concrete">
          {n.tags.length > 0 && <span>#{n.tags.join(' #')}</span>}
          {n.links.length > 0 && <span>{n.links.length} link{n.links.length === 1 ? '' : 's'}</span>}
          {(n.attach?.length ?? 0) > 0 && (
            <span title={n.attach!.join(', ')}>
              keeps {n.attach!.length === 1 ? n.attach![0] : `${n.attach!.length} files`}
            </span>
          )}
          {(n.embeds ?? []).map((e, i) => (
            <span key={i}>{e.kind === 'place' ? `place: ${e.place?.name ?? e.title ?? ''}` : e.kind === 'youtube' ? 'video' : 'page'}</span>
          ))}
          {n.source.ref && <span className="max-w-full truncate">from {n.source.ref}</span>}
        </div>
      )}
      {card.instruction && <div className="mt-1 text-[11px] text-concrete">You asked: {card.instruction}</div>}
      {card.error && <div className="mt-1 text-[11px] text-signal">{card.error}</div>}
      {open && writer && !editing && (
        <div className="mt-2 flex gap-1">
          <button type="button" className={BTN_PRIMARY} onClick={() => void keepCard(toolId, card.key)} title="Keep (K)">
            Keep
          </button>
          {cloudEnabled && <button type="button" className={BTN} onClick={() => setEditing(true)} title="Ask for a change (E)">
            Edit
          </button>}
          <button type="button" className={BTN} onClick={() => skipCard(toolId, card.key)} title="Skip (S)">
            Skip
          </button>
        </div>
      )}
      {open && editing && cloudEnabled && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            editCard(toolId, card.key, instruction)
            setEditing(false)
          }}
        >
          <input
            autoFocus
            className="min-w-0 flex-1 border border-bone/30 bg-void px-2 py-1 font-mono text-[12px] text-bone outline-none focus:border-ember"
            placeholder="e.g. make it 2019, merge with Entropy"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(false))}
          />
          <button type="submit" className={BTN}>
            Ask
          </button>
        </form>
      )}
    </li>
  )
}

function AddToTitle({ id }: { id: string }) {
  const title = useWorld((s) => s.nodes.get(id)?.title)
  return <span className="font-semibold">{title ?? 'a note that no longer exists'}</span>
}

function Proposals({ toolId, writer }: { toolId: string; writer: boolean }) {
  const cards = useChat((s) => s.cards[toolId])
  if (!cards?.length) return null
  const open = cards.filter((c) => c.status === 'open').length
  return (
    <div className="my-2">
      {open > 1 && writer && (
        <div className="mb-1 flex justify-end">
          <button type="button" className={BTN} onClick={() => void keepAll(toolId)}>
            Keep all {open}
          </button>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {cards.map((c) => (
          <CardView key={c.key} toolId={toolId} card={c} writer={writer} />
        ))}
      </ul>
    </div>
  )
}

function AskView({ toolId, writer }: { toolId: string; writer: boolean }) {
  const ask = useChat((s) => s.asks[toolId])
  const cloudEnabled = useChat((s) => s.cloudAi === 'enabled')
  if (!ask) return null
  return (
    <div className="my-2 border-l-2 border-ember pl-3">
      <div className="text-[13px] text-bone">{ask.input.question}</div>
      {cloudEnabled ? <div className="mt-1.5 flex flex-wrap gap-1">
        {ask.input.options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={!!ask.answer || !writer}
            className={ask.answer === o ? BTN_PRIMARY : BTN}
            onClick={() => answerAsk(toolId, o)}
          >
            {o}
          </button>
        ))}
      </div> : ask.answer ? <p className="chat-saved-answer">{ask.answer}</p> : null}
    </div>
  )
}

/** Only actual tool-issued source links are actionable; generated IDs remain plain text. */
export function evidenceLinks(text: string, citations: Readonly<Record<string, EvidenceCitation>>): EvidenceCitation[] {
  const urls = [...text.matchAll(/\[[^\]\n]{1,200}\]\((#\/library\?[^\s()]+)\)/g)].map((m) => m[1])
  return [...new Set(urls)].flatMap((url) => {
    const citation = citations[url]
    return citation && citation.citationUrl === url && citationAllowed(citation) ? [citation] : []
  })
}

function EvidenceText({ text, question = 'Saved answer', streaming = false }: { text: string; question?: string; streaming?: boolean }) {
  const citations = useChat((s) => s.citations)
  const writer = useRepoStatus((s) => s.writer)
  const [saved, setSaved] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('')
  // Permissions and scope can change while an old answer stays visible locally.
  useKnowledge((s) => s.sources)
  useWorld((s) => s.nodes)
  useWorkspace((s) => JSON.stringify([s.sourceIds, s.role, s.sourceKind, s.authoredAfter, s.authoredBefore]))
  const sources = evidenceLinks(text, citations)
  const passages = sources.filter((s) => s.passageId && s.versionId)
  async function save() {
    setSaving(true); setError('')
    try {
      const page = await promoteAnswer({ title: question.slice(0, 120), question, answer: text, evidence: passages.map((s) => ({ passageId: s.passageId!, sourceVersionId: s.versionId!, relation: 'context' as const })), sourceIds: [...new Set(passages.flatMap((s) => s.sourceId ?? []))] })
      setSaved(page.id)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setSaving(false) }
  }
  return <>
    <Markdown source={text} className="text-[13px] leading-relaxed text-bone" />
    {sources.length > 0 && <nav aria-label="Answer sources" className="chat-evidence-links">
      {sources.map((source) => <a key={source.citationUrl} href={source.citationUrl}><Paperclip size={14} aria-hidden="true" /><span>{source.title}</span></a>)}
    </nav>}
    {!streaming && !sources.length && <p className="knowledge-secondary">No verified source citations in the current scope.</p>}
    {passages.length > 0 && (saved ? <a className="knowledge-text-button" href={`#/knowledge?page=${saved}`}>Open saved knowledge page</a> : <button className="knowledge-text-button" disabled={!writer || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save answer as knowledge page'}</button>)}
    {error && <p role="alert" className="knowledge-error">{error}</p>}
  </>
}

function Turn({ role, content, writer, question }: { role: 'user' | 'assistant'; content: unknown; writer: boolean; question?: string }) {
  const parts: ReactNode[] = []
  const chips: string[] = []
  blocksOf(content).forEach((b, i) => {
    if (role === 'user') {
      const chip = chipOf(b)
      if (chip) chips.push(chip)
      else if (b.type === 'text' && !isHiddenText(b.text) && b.text.trim()) {
        parts.push(
          <div key={i} className="chat-user-turn ml-auto max-w-[85%] whitespace-pre-wrap border border-bone/20 bg-bone/5 px-3 py-2 text-[13px] text-bone">
            {b.text}
          </div>,
        )
      }
      return
    }
    if (b.type === 'text' && b.text.trim()) parts.push(<EvidenceText key={i} text={b.text} question={question} />)
    else if (b.type === 'tool_use') {
      if (b.name === 'propose_notes') parts.push(<Proposals key={i} toolId={b.id} writer={writer} />)
      else if (b.name === 'ask_user') parts.push(<AskView key={i} toolId={b.id} writer={writer} />)
      else if (b.name === 'read_memory_context' || b.name === 'search_world' || b.name === 'search_passages') {
        const q = (b.input as { query?: string } | null)?.query
        parts.push(
          <div key={i} className="text-[11px] text-concrete">
            {b.name === 'read_memory_context' ? 'Prepared evidence and approved context' : b.name === 'search_passages' ? 'Searched original sources' : 'Looked through your notes'}{q ? ` for “${q}”` : ''}
          </div>,
        )
      } else if (b.name === 'read_record' || b.name === 'read_passage') {
        parts.push(<div key={i} className="text-[11px] text-concrete">Read supporting evidence</div>)
      }
    }
  })
  if (chips.length) {
    parts.unshift(
      <div key="chips" className="ml-auto flex max-w-[85%] flex-wrap justify-end gap-1">
        {chips.map((c, i) => (
          <span key={i} className="border border-bone/20 px-1.5 py-0.5 text-[11px] text-concrete">
            {c}
          </span>
        ))}
      </div>,
    )
  }
  return parts.length ? <div className="flex flex-col gap-1.5">{parts}</div> : null
}

async function downloadVault(): Promise<void> {
  const records = [...useWorld.getState().nodes.values()]
  // Originals travel as files beside the notes, at the paths their frontmatter names.
  const files = new Map<string, string | Uint8Array>(exportVault(records))
  for (const { path, blobId } of vaultAttachments(records)) {
    const blob = await getStore().getBlob(blobId).catch(() => undefined)
    if (blob) files.set(path, new Uint8Array(await blob.arrayBuffer()))
  }
  const zip = zipVault(files)
  const url = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `Worldview vault ${new Date().toISOString().slice(0, 10)}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function CapturedNote({ id, embedded }: { id: string; embedded: boolean }) {
  const note = useWorld((s) => s.nodes.get(id))
  if (!note || note.deletedAt) return null
  const date = new Date(note.temporalOrigin).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const open = () => {
    if (embedded) { openWorkspaceRecord(id); useApp.getState().togglePanel('chat', false) }
    else selectAndFly(id)
  }
  return (
    <article className="chat-captured-note">
      <div className="chat-captured-meta">{KIND_LABEL[note.archetype]} <span>·</span> {date}</div>
      <button type="button" className="chat-captured-title" onClick={open}>
        <span>{note.title}</span><ArrowUpRight size={16} />
      </button>
      {note.contentMd && <p>{note.contentMd.replace(/^#+\s*/gm, '').slice(0, 180)}</p>}
      {note.attachments.length > 0 && <div className="chat-captured-files"><Paperclip size={13} /><span>{note.attachments.map((a) => a.name).join(', ')}</span></div>}
      {note.tags.length > 0 && <div className="chat-captured-tags">{note.tags.slice(0, 4).map((t) => <span key={t}>#{t}</span>)}</div>}
      <button type="button" className="chat-captured-open" onClick={open}>{embedded ? 'Read note' : 'Find in world'} <ArrowUpRight size={13} /></button>
    </article>
  )
}

export function Chat({ embedded = false }: { embedded?: boolean }) {
  const open = useApp((s) => s.panels.chat)
  const writer = useRepoStatus((s) => s.writer)
  const ready = useRepoStatus((s) => s.ready)
  const { history, live, busy, toolHint, error, staged, intakeBusy, cloudAi } = useChat()
  const cloudEnabled = cloudAi === 'enabled'
  const text = useWorkspace((s) => s.quickCaptureDraft)
  const [full, setFull] = useState(false)
  const [reflection, setReflection] = useState(false)
  const [captureIds, setCaptureIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (ready) {
      void loadChat()
      void refreshCloudAiStatus()
    }
  }, [ready])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history.length, live, staged.length, open, captureIds.length, error])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const turns = useMemo(
    () => history.map((m, i) => {
      const preceding = history.slice(0, i).reverse().find((turn) => turn.role === 'user' && blocksOf(turn.content).some((b) => b.type === 'text' && !isHiddenText(b.text)))
      const question = preceding ? blocksOf(preceding.content).flatMap((b) => b.type === 'text' && !isHiddenText(b.text) ? [b.text] : []).join('\n') : 'Saved answer'
      return m.role === 'user' || m.role === 'assistant' ? <Turn key={i} role={m.role} content={m.content} writer={writer} question={question} /> : null
    }),
    [history, writer],
  )

  if (!open && !embedded) return null

  const working = busy || intakeBusy || saving
  const canSave = !!text.trim() || staged.some((item) => item.file || item.url)
  const submit = async () => {
    if (!cloudEnabled || working || !writer || (!text.trim() && !staged.length)) return
    const t = text
    setText('')
    await send(t)
    if (useChat.getState().error) setText((draft) => draft || t)
  }

  const saveFiles = async () => {
    if (working || !writer) return
    setSaving(true)
    const before = new Set(useWorld.getState().nodes.keys())
    try {
      await keepStaged()
      const created = [...useWorld.getState().nodes.keys()].filter((id) => !before.has(id))
      if (created.length) setCaptureIds((ids) => [...ids, ...created].slice(-8))
    } finally {
      setSaving(false)
    }
  }

  const saveLocal = async () => {
    if (working || !writer) return
    if (!text.trim()) return saveFiles()
    setSaving(true)
    const draft = text
    try {
      const id = await saveThought(draft, { reflection })
      if (id) {
        setText((current) => current === draft ? '' : current)
        setReflection(false)
        setCaptureIds((ids) => [...ids, id].slice(-8))
      }
    } finally {
      setSaving(false)
    }
  }

  const shell = embedded
    ? 'chat-panel chat-embedded pointer-events-auto flex h-full min-h-0 w-full flex-col'
    : full
      ? 'chat-panel pointer-events-auto fixed inset-0 z-40 flex justify-center bg-void/95 backdrop-blur-sm'
      : 'chat-panel pointer-events-auto absolute bottom-3 right-3 top-3 z-20 flex w-[min(440px,calc(100%-24px))]'

  return (
    <section
      aria-label={cloudEnabled ? 'Companion' : 'Quick capture'}
      data-label-avoid={full ? undefined : ''}
      className={`${shell} ${dropOver ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files') || !writer) return
        e.preventDefault()
        setDropOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false)
      }}
      onDrop={(e) => {
        if (!writer || !Array.from(e.dataTransfer.types).includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        setDropOver(false)
        void intake(Array.from(e.dataTransfer.files), entriesOf(e.dataTransfer))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.stopPropagation()
          if (full) setFull(false)
          else useApp.getState().togglePanel('chat', false)
        }
      }}
    >
      <div className={`chat-body flex min-h-0 w-full flex-1 flex-col ${full ? 'my-6 max-w-2xl' : ''}`}>
        <header className="chat-header">
          {cloudEnabled ? <Sparkle size={21} weight="light" aria-hidden="true" /> : <Notebook size={21} weight="light" aria-hidden="true" />}
          <div className="chat-header-title"><h2>{cloudEnabled ? 'Companion' : 'Quick capture'}</h2><p>{cloudEnabled ? 'Explore your thinking' : 'Keep a thought. Bring a file.'}</p></div>
          <button type="button" className="chat-icon-button" aria-label="Close capture panel" onClick={() => useApp.getState().togglePanel('chat', false)}><X size={16} /></button>
        </header>

        <div ref={listRef} className="chat-messages flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {!history.length && !captureIds.length && !busy && (
            <div className="chat-welcome">
              <h3>{cloudEnabled ? 'Where shall we explore?' : 'A place to catch your thoughts.'}</h3>
              <p>{cloudEnabled ? <>Follow an idea. Remember a moment.<br />Make room for something new.</> : 'Write a note, drop a file, or save a moment. Your words and originals stay in your world.'}</p>
              <div className="chat-starters">
                {cloudEnabled && <button type="button" onClick={() => { setText((draft) => draft || 'What connections do you see between my recent thoughts?'); inputRef.current?.focus() }}>Find connections <ArrowUpRight size={15} /></button>}
                {!cloudEnabled && <button type="button" onClick={() => inputRef.current?.focus()}>Write a thought <ArrowUpRight size={15} /></button>}
                <button type="button" onClick={() => { setReflection(true); setText((draft) => draft || 'Today I’ve been thinking about '); inputRef.current?.focus() }}>Reflect on today <ArrowUpRight size={15} /></button>
                {cloudEnabled ? <button type="button" onClick={() => inputRef.current?.focus()}>Add a thought <ArrowUpRight size={15} /></button> : <button type="button" disabled={!writer} onClick={() => fileRef.current?.click()}>Bring a file <Paperclip size={15} /></button>}
              </div>
              {cloudEnabled && <button type="button" className="chat-meet-agents" onClick={openAgentsPanel}>Meet your agents <ArrowUpRight size={13} /></button>}
            </div>
          )}
          {!cloudEnabled && history.length > 0 && <p className="chat-history-label">Saved conversations</p>}
          {turns}
          {live && <EvidenceText text={live} streaming />}
          {captureIds.length > 0 && (
            <div className="chat-captures">
              <div className="chat-captures-heading" role="status"><CheckCircle size={16} /> Added to your world</div>
              {captureIds.map((id) => <CapturedNote key={id} id={id} embedded={embedded} />)}
            </div>
          )}
          {working && (
            <div className="chat-progress" role="status">
              {intakeBusy ? 'Preparing your files…' : saving ? 'Adding to your world…' : toolHint === 'propose_notes' ? 'Finding a place for these thoughts…' : toolHint === 'search_world' || toolHint === 'search_passages' ? 'Looking through your sources…' : toolHint === 'read_record' || toolHint === 'read_passage' ? 'Reading the evidence…' : 'Thinking…'}
            </div>
          )}
          {error && <div role="alert" className="chat-error">{error}</div>}
        </div>

        <footer className="chat-footer">
          {staged.length > 0 && (
            <div className="chat-attachments">
              {staged.map((s, i) => (
                <span key={i} className="chat-attachment">
                  <span>{s.name}</span>
                  <button type="button" aria-label={`Remove ${s.name}`} onClick={() => unstage(i)}><X size={16} /></button>
                </span>
              ))}
              {staged.some((s) => s.file || s.url) && (
                <button type="button" className="chat-save-files" disabled={working || !writer} onClick={() => void saveFiles()}>Save files to world</button>
              )}
            </div>
          )}
          {reflection && <div className="chat-reflection-label">Daily reflection <button type="button" aria-label="Cancel reflection" onClick={() => setReflection(false)}><X size={16} /></button></div>}
          <div className="chat-composer">
            <textarea
              ref={inputRef}
              rows={2}
              maxLength={QUICK_CAPTURE_DRAFT_LIMIT}
              disabled={!writer}
              aria-label="Your thought"
              placeholder={dropOver ? 'Drop it here. Make it part of your world.' : writer ? captureIds.length ? 'Keep thinking…' : 'Add a thought, file, or link…' : 'Another tab is editing this world'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && (cloudEnabled ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (cloudEnabled) void submit()
                  else void saveLocal()
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files)
                if (files.length) { e.preventDefault(); void intake(files) }
              }}
            />
            <div className="chat-composer-tools">
              <button type="button" className="chat-icon-button chat-attach" aria-label="Attach files" disabled={!writer || intakeBusy} title="Add photos, videos, PDFs, or other files" onClick={() => fileRef.current?.click()}><Paperclip size={18} /></button>
              <button type="button" className="chat-folder-button" disabled={!writer || intakeBusy} onClick={() => dirRef.current?.click()}>Folder</button>
              <span className="chat-composer-spacer" />
              <button type="button" className={cloudEnabled ? 'chat-local-save' : 'chat-local-save is-primary'} disabled={working || !writer || !canSave} onClick={() => void saveLocal()} title="Save your words and original files to your world">{saving ? 'Saving…' : 'Save to world'}</button>
              {cloudEnabled && <button type="button" className="chat-send" aria-label="Send to AI" disabled={working || !writer || (!text.trim() && !staged.length)} onClick={() => void submit()} title="Send to the AI assistant"><ArrowUp size={18} /></button>}
            </div>
          </div>
          <p className="chat-privacy">{cloudEnabled ? 'Save to your world, or send to AI.' : <>Local capture · <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to save</>}</p>
          <div className="chat-bottom-tools">
            <button type="button" onClick={() => void downloadVault()} title="Export all your notes and original files as an Obsidian vault">Export notes</button>
            {!embedded && <button type="button" onClick={() => setFull((f) => !f)}>{full ? 'Dock panel' : 'Expand panel'}</button>}
            <a className="chat-cloud-setting" href="#/sources?connection=cloud" title={cloudEnabled ? 'Manage optional cloud AI' : 'Cloud AI is off. Manage optional connections.'}>{cloudEnabled ? 'Cloud AI on' : 'Cloud AI off'}</a>
          </div>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => {
            const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void intake(files)
          }} />
          <input ref={dirRef} type="file" hidden
            // @ts-expect-error webkitdirectory is not in React's input attributes
            webkitdirectory="" onChange={(e) => {
              const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void intakeFolderFiles(files)
            }} />
        </footer>
      </div>
    </section>
  )
}
