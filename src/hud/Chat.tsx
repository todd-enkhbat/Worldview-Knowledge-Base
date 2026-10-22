import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type Anthropic from '@anthropic-ai/sdk'
import { useApp, useWorld } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { exportVault, zipVault } from '../data/obsidian.ts'
import {
  answerAsk,
  editCard,
  isHiddenText,
  keepAll,
  keepCard,
  loadChat,
  send,
  skipCard,
  startInterview,
  unstage,
  useChat,
  type Card,
} from '../ai/chat/session.ts'
import { BTN, BTN_PRIMARY } from './DurabilityKit.tsx'
import { Markdown } from './markdown.ts'
import { intake, intakeVaultFiles } from './chatIntake.ts'
import { selectAndFly } from './shortcuts.ts'

// The chat (milestone 1): the front door of the world. Talk, drop files or a vault folder,
// paste links; Claude proposes notes as cards and nothing is saved until you keep one.
// Full screen for the first-visit interview, docked on the right afterwards. "/" opens it.

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
    const page = /^<page url=("[^"]*") title=("[^"]*")/.exec(b.text)
    if (page) return `Page · ${JSON.parse(page[2]) as string}`
    if (b.text.startsWith('[ui:imported]')) return 'Obsidian vault imported'
  }
  return null
}

function CardView({ toolId, card, writer }: { toolId: string; card: Card; writer: boolean }) {
  const [editing, setEditing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const n = card.note
  const open = card.status === 'open'
  const onKey = (e: ReactKeyboardEvent) => {
    if (!open || !writer || e.target !== e.currentTarget) return
    if (e.key === 'k') void keepCard(toolId, card.key)
    else if (e.key === 's') skipCard(toolId, card.key)
    else if (e.key === 'e') setEditing(true)
  }
  return (
    <li
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Proposed ${KIND_LABEL[n.kind] ?? n.kind}: ${n.title}`}
      className={`border px-3 py-2 outline-none focus-visible:border-ember ${card.status === 'kept' ? 'border-ember/50 bg-ember/5' : card.status === 'open' ? 'border-bone/25' : 'border-bone/10 opacity-60'}`}
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
      {(n.tags.length > 0 || n.links.length > 0 || n.source.ref) && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-concrete">
          {n.tags.length > 0 && <span>#{n.tags.join(' #')}</span>}
          {n.links.length > 0 && <span>{n.links.length} link{n.links.length === 1 ? '' : 's'}</span>}
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
          <button type="button" className={BTN} onClick={() => setEditing(true)} title="Ask for a change (E)">
            Edit
          </button>
          <button type="button" className={BTN} onClick={() => skipCard(toolId, card.key)} title="Skip (S)">
            Skip
          </button>
        </div>
      )}
      {open && editing && (
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
  if (!ask) return null
  return (
    <div className="my-2 border-l-2 border-ember pl-3">
      <div className="text-[13px] text-bone">{ask.input.question}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
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
      </div>
    </div>
  )
}

function Turn({ role, content, writer }: { role: 'user' | 'assistant'; content: unknown; writer: boolean }) {
  const parts: ReactNode[] = []
  const chips: string[] = []
  blocksOf(content).forEach((b, i) => {
    if (role === 'user') {
      const chip = chipOf(b)
      if (chip) chips.push(chip)
      else if (b.type === 'text' && !isHiddenText(b.text) && b.text.trim()) {
        parts.push(
          <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap border border-bone/20 bg-bone/5 px-3 py-2 text-[13px] text-bone">
            {b.text}
          </div>,
        )
      }
      return
    }
    if (b.type === 'text' && b.text.trim()) parts.push(<Markdown key={i} source={b.text} className="text-[13px] leading-relaxed text-bone" />)
    else if (b.type === 'tool_use') {
      if (b.name === 'propose_notes') parts.push(<Proposals key={i} toolId={b.id} writer={writer} />)
      else if (b.name === 'ask_user') parts.push(<AskView key={i} toolId={b.id} writer={writer} />)
      else if (b.name === 'search_world') {
        const q = (b.input as { query?: string } | null)?.query
        parts.push(
          <div key={i} className="text-[11px] text-concrete">
            Looked through your notes{q ? ` for “${q}”` : ''}
          </div>,
        )
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

function downloadVault(): void {
  const w = useWorld.getState()
  const zip = zipVault(exportVault([...w.nodes.values()]))
  const url = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `Worldview vault ${new Date().toISOString().slice(0, 10)}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function Chat() {
  const open = useApp((s) => s.panels.chat)
  const writer = useRepoStatus((s) => s.writer)
  const ready = useRepoStatus((s) => s.ready)
  const settings = useWorld((s) => s.settings)
  const empty = useWorld((s) => s.nodes.size === 0)
  const { history, live, busy, toolHint, error, staged, loaded, usage } = useChat()
  const [text, setText] = useState('')
  const [full, setFull] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (ready) void loadChat()
  }, [ready])

  // First visit: an empty world with no conversation opens the interview, full screen.
  useEffect(() => {
    if (!loaded || !writer || !settings || !empty || history.length) return
    setFull(true)
    useApp.getState().togglePanel('chat', true)
    startInterview()
  }, [loaded, writer, settings, empty, history.length])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history.length, live, staged.length, open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const turns = useMemo(
    () => history.map((m, i) => (m.role === 'user' || m.role === 'assistant' ? <Turn key={i} role={m.role} content={m.content} writer={writer} /> : null)),
    [history, writer],
  )

  if (!open) return null

  const submit = () => {
    if (busy || !writer) return
    const t = text
    setText('')
    void send(t)
  }

  const shell = full
    ? 'pointer-events-auto fixed inset-0 z-40 flex justify-center bg-void/95 backdrop-blur-sm'
    : 'pointer-events-auto absolute bottom-3 right-3 top-3 z-20 flex w-[min(440px,calc(100%-24px))]'

  return (
    <section
      aria-label="Chat"
      data-label-avoid={full ? undefined : ''}
      className={shell}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.stopPropagation()
          if (full) setFull(false)
          else useApp.getState().togglePanel('chat', false)
        }
      }}
    >
      <div className={`hud-panel flex min-h-0 w-full flex-col ${full ? 'my-6 max-w-2xl' : ''}`}>
        <header className="flex items-center gap-2 border-b border-bone/15 px-3 py-2">
          <span className="hud-label">Talk to your world</span>
          <span className="ml-auto" />
          <button type="button" className={`${BTN} px-1.5 py-0`} onClick={downloadVault} title="Export every note as an Obsidian vault (.zip)">
            Export vault
          </button>
          <button type="button" className={`${BTN} px-1.5 py-0`} onClick={() => setFull((f) => !f)} title={full ? 'Dock to the side' : 'Full screen'}>
            {full ? 'Dock' : 'Expand'}
          </button>
          <button type="button" className={`${BTN} px-1.5 py-0`} aria-label="Close the chat" onClick={() => useApp.getState().togglePanel('chat', false)}>
            ×
          </button>
        </header>

        <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
          {!history.length && !busy && (
            <div className="text-[13px] leading-relaxed text-concrete">
              Tell me about anything: an idea you keep coming back to, a person who shaped you, a moment you remember. Drop in files, a folder of notes or an Obsidian
              vault, or paste a link. I&apos;ll propose notes; nothing is saved until you keep it.
            </div>
          )}
          {turns}
          {live && <Markdown source={live} className="text-[13px] leading-relaxed text-bone" />}
          {busy && (
            <div className="hud-label animate-pulse" role="status">
              {toolHint === 'propose_notes' ? 'Writing notes…' : toolHint === 'search_world' ? 'Looking through your notes…' : toolHint === 'ask_user' ? 'Thinking of a question…' : 'Thinking…'}
            </div>
          )}
          {error && (
            <div role="alert" className="border-l-2 border-signal pl-2 text-[12px] text-signal">
              {error}
            </div>
          )}
        </div>

        <footer className="border-t border-bone/15 p-2">
          {staged.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {staged.map((s, i) => (
                <span key={i} className="flex items-center gap-1 border border-bone/25 px-1.5 py-0.5 text-[11px] text-bone">
                  {s.kind === 'pdf' ? 'PDF' : s.kind === 'image' ? 'Image' : s.kind === 'page' ? 'Page' : 'File'} · {s.name}
                  <button type="button" aria-label={`Remove ${s.name}`} className="text-concrete hover:text-bone" onClick={() => unstage(i)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1">
            <textarea
              ref={inputRef}
              rows={full ? 3 : 2}
              disabled={!writer}
              className="min-h-0 flex-1 resize-none border border-bone/30 bg-void px-2 py-1.5 font-mono text-[13px] text-bone outline-none placeholder:text-concrete focus:border-ember"
              placeholder={writer ? 'Say anything, paste a link, or drop files here…' : 'Read-only: another tab is the writer'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files)
                if (files.length) {
                  e.preventDefault()
                  void intake(files)
                }
              }}
            />
            <div className="flex flex-col gap-1">
              <button type="button" className={BTN_PRIMARY} disabled={busy || !writer} onClick={submit}>
                Send
              </button>
              <button type="button" className={BTN} disabled={!writer} title="Attach files (PDF, images, text, markdown)" onClick={() => fileRef.current?.click()}>
                Files
              </button>
              <button type="button" className={BTN} disabled={!writer} title="Import a folder of notes or an Obsidian vault" onClick={() => dirRef.current?.click()}>
                Vault
              </button>
            </div>
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-concrete">
            <span>Files and pages you add are sent to Anthropic&apos;s API to read them.</span>
            {usage.input + usage.output > 0 && (
              <span title="Tokens this session (input / output / read from cache)">
                {usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out · {usage.cacheRead.toLocaleString()} cached
              </span>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.md,.markdown,.txt,.csv,.json,.html,.htm,image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length) void intake(files)
            }}
          />
          <input
            ref={dirRef}
            type="file"
            hidden
            // @ts-expect-error webkitdirectory is not in React's input attributes
            webkitdirectory=""
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length) void intakeVaultFiles(files)
            }}
          />
        </footer>
      </div>
    </section>
  )
}
