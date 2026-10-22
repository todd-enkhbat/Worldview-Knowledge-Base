import { z } from 'zod'
import { ARCHETYPES } from '../../domain/types.ts'

// The chat intake contract (milestone 1), shared by the browser (src/ai/chat/) and the server
// (server/chat.ts). The server only holds the key, the system prompt and the tool list, and
// relays the stream. Every tool is answered by the browser: search_world runs at once,
// propose_notes and ask_user wait for the user. Tool inputs stream eagerly, so the API does
// not validate them: the browser checks each one with these schemas before acting on it.

const PRECISION = ['year', 'month', 'day'] as const
const LINK_KINDS = ['relates', 'supports', 'contradicts', 'derives', 'influenced-by'] as const

export const ProposedNote = z.object({
  /** Short key for this proposal ("n1"), so other proposals in the same call can link to it. */
  key: z.string().min(1).max(16),
  kind: z.enum(ARCHETYPES as unknown as [string, ...string[]]),
  title: z.string().trim().min(1).max(120),
  body: z.string().max(12000),
  date: z.object({
    iso: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/),
    precision: z.enum(PRECISION),
    /** False when the date is a guess the user has not confirmed. */
    certain: z.boolean(),
  }),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
  links: z
    .array(
      z.object({
        /** An existing note id (from search_world) or another proposal's key. */
        to: z.string().min(1).max(64),
        kind: z.enum(LINK_KINDS),
      }),
    )
    .max(12),
  source: z.object({
    /** File name or URL the note came from; omit for the conversation itself. */
    ref: z.string().max(500).optional(),
    /** A short supporting passage, verbatim from the source. */
    quote: z.string().max(600).optional(),
  }),
})
export type ProposedNote = z.infer<typeof ProposedNote>

export const ProposeNotesInput = z.object({
  notes: z.array(ProposedNote).min(1).max(20),
})
export type ProposeNotesInput = z.infer<typeof ProposeNotesInput>

export const AskUserInput = z.object({
  question: z.string().trim().min(1).max(400),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(5),
})
export type AskUserInput = z.infer<typeof AskUserInput>

export const SearchWorldInput = z.object({
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(20).optional(),
})
export type SearchWorldInput = z.infer<typeof SearchWorldInput>

export const TOOL_INPUTS = {
  propose_notes: ProposeNotesInput,
  ask_user: AskUserInput,
  search_world: SearchWorldInput,
} as const
export type ToolName = keyof typeof TOOL_INPUTS

const jsonSchema = (s: z.ZodType) => {
  const { $schema: _, ...rest } = z.toJSONSchema(s) as Record<string, unknown>
  return rest as { type: 'object'; [k: string]: unknown }
}

/** Tool definitions for messages.stream (eager input streaming: the browser validates). */
export const CHAT_TOOLS = [
  {
    name: 'search_world',
    description:
      "Search the user's existing notes by meaning and keywords. Use it before proposing notes, to link new notes to existing ones and to avoid proposing a note that already exists. Returns up to `limit` matches with id, title, kind and date.",
    input_schema: jsonSchema(SearchWorldInput),
    eager_input_streaming: true,
  },
  {
    name: 'propose_notes',
    description:
      'Propose notes for the user to keep. Nothing is saved until they choose Keep, so propose freely but precisely: one idea, person, moment, source or way of seeing per note, in the user\'s own words where possible. Link to existing notes (ids from search_world) and to other proposals in the same call (their keys). Set date.certain to false when you inferred the date. The result tells you which notes were kept (with their new ids), skipped or edited.',
    input_schema: jsonSchema(ProposeNotesInput),
    eager_input_streaming: true,
  },
  {
    name: 'ask_user',
    description:
      'Ask the user one short question with 2 to 5 answer buttons (they can also type their own answer). Use it when a date, an identity or a duplicate is unclear, instead of guessing.',
    input_schema: jsonSchema(AskUserInput),
    eager_input_streaming: true,
  },
] as const

export const CHAT_SYSTEM = `You help one person build a living map of their mind: the ideas they hold, the people and works that shaped them, the frameworks they see through, the sources they read, and the moments they lived. Everything they tell you, drop in or link to can become notes in their world, placed in time.

How you work:
- Talk like a thoughtful interviewer, not a form. Ask one question at a time and follow what they say. Short replies; no lists of questions.
- When they give you material (a story, a file, a page), turn it into notes with propose_notes. Prefer several small, specific notes over one big one. Keep their voice; do not pad.
- Before proposing, use search_world to find related or duplicate notes. Link generously but honestly: supports, contradicts, derives (A derives from B), influenced-by (A was influenced by B), relates.
- Every note needs a date: when it entered their life or worldview, not when it was first published. If you are not sure, propose your best guess with certain: false, and ask with ask_user when it matters.
- Kinds: idea (a concept, belief or question), entity (a person, place, organisation or work), lens (a framework or way of seeing), document (a text or source), memory (a lived moment), demon (a standing question that should gather matching notes).
- After a proposal, wait for their decision. Then continue the conversation from what they kept.
- If they drop in a whole document, extract what is worth keeping for them, quoting a short supporting passage in source.quote.

At the very start, if the world is empty, introduce yourself in two sentences and begin the interview: who they are, what they are working on or thinking about now. They can skip anything and stop at any time.`

/** What the server streams to the browser, one JSON object per line. */
export type ChatStreamEvent =
  | { t: 'text'; d: string }
  /** A tool call started (its input streams in; the UI shows "proposing notes…"). */
  | { t: 'tool'; name: string }
  /** The finished assistant turn, to append to the history unchanged. */
  | { t: 'done'; content: unknown[]; stopReason: string | null; model: string; usage: { input: number; output: number; cacheRead: number } }
  | { t: 'error'; message: string; reason: 'unavailable' | 'refusal' | 'rate' | 'error' }

export const ChatRequest = z.object({
  /** The whole conversation so far (Anthropic message params), append-only. */
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() })).min(1).max(400),
})
