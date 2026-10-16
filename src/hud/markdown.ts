import { createElement as h, useMemo, type ReactNode } from 'react'

// A deliberately tiny Markdown subset rendered straight to React elements. There is no HTML
// pass at all: raw HTML in the source is text (React escapes it), and only http(s) links
// survive, so note content can never inject markup or script. Parsing is split from
// rendering so the grammar can be unit-tested without a DOM.

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'link'; href: string; title?: string; children: MdInline[] }
  | { type: 'br' }

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { type: 'blockquote'; children: MdBlock[] }
  | { type: 'hr' }

/** Nesting cap for quotes/lists and for emphasis, so hostile input cannot blow the stack. */
const MAX_DEPTH = 12

// ─── links ───────────────────────────────────────────────────────────────────────────

/** The normalised href when `url` is an absolute http(s) URL, else null. Everything else is dropped. */
export function safeHref(url: string): string | null {
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) return null
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

// ─── blocks ──────────────────────────────────────────────────────────────────────────

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE_RE = /^ {0,3}> ?/
const ITEM_RE = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/

const isBlank = (l: string) => l.trim() === ''
const indentOf = (l: string) => l.length - l.trimStart().length

function itemMatch(l: string): { indent: number; marker: string; text: string; ordered: boolean } | null {
  const m = ITEM_RE.exec(l)
  if (!m) return null
  return { indent: m[1].length, marker: m[2], text: m[3] ?? '', ordered: /\d/.test(m[2]) }
}

/** Would `line` start a new block (and so end a paragraph)? */
function interrupts(line: string): boolean {
  if (FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true
  const it = itemMatch(line)
  // Only "1." may interrupt a paragraph, so prose like "In\n2019. we moved" stays prose.
  return !!it && it.text.trim() !== '' && (!it.ordered || parseInt(it.marker, 10) === 1)
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  return parseBlocks(lines, 0)
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const strip = indentOf(line)
      const body: string[] = []
      i++
      while (i < lines.length && !isFenceClose(lines[i], marker)) {
        const l = lines[i]
        body.push(l.slice(Math.min(strip, indentOf(l))))
        i++
      }
      i++ // closing fence (or past the end: an unclosed fence runs to EOF)
      out.push({ type: 'code', lang: fence[2] || null, text: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6
      out.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') })
      i++
      continue
    }

    if (HR_RE.test(line)) {
      out.push({ type: 'hr' })
      i++
      continue
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(QUOTE_RE, ''))
        i++
      }
      out.push(
        depth < MAX_DEPTH
          ? { type: 'blockquote', children: parseBlocks(inner, depth + 1) }
          : { type: 'paragraph', children: parseInline(inner.join('\n')) },
      )
      continue
    }

    const first = itemMatch(line)
    if (first) {
      const list: Extract<MdBlock, { type: 'list' }> = {
        type: 'list',
        ordered: first.ordered,
        start: first.ordered ? parseInt(first.marker, 10) : 1,
        items: [],
      }
      while (i < lines.length) {
        const it = itemMatch(lines[i])
        if (!it || it.ordered !== list.ordered) break
        const contentIndent = it.indent + it.marker.length + 1
        const itemLines = [it.text]
        i++
        while (i < lines.length) {
          const l = lines[i]
          if (isBlank(l)) {
            // A blank line continues the item only if indented content follows it.
            let j = i + 1
            while (j < lines.length && isBlank(lines[j])) j++
            if (j < lines.length && indentOf(lines[j]) >= 2) {
              for (; i < j; i++) itemLines.push('')
              continue
            }
            break
          }
          if (indentOf(l) >= 2) {
            itemLines.push(l.slice(Math.min(indentOf(l), contentIndent)))
            i++
            continue
          }
          // Lazy continuation of the item's paragraph.
          if (!isBlank(itemLines[itemLines.length - 1]) && !interrupts(l) && !itemMatch(l)) {
            itemLines.push(l.trimStart())
            i++
            continue
          }
          break
        }
        list.items.push(
          depth < MAX_DEPTH ? parseBlocks(itemLines, depth + 1) : [{ type: 'paragraph', children: parseInline(itemLines.join('\n')) }],
        )
        // Blank lines between items keep the list going (a "loose" list).
        let j = i
        while (j < lines.length && isBlank(lines[j])) j++
        const next = j < lines.length ? itemMatch(lines[j]) : null
        if (next && next.ordered === list.ordered) i = j
        else break
      }
      out.push(list)
      continue
    }

    const para: string[] = [line]
    i++
    while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines[i])) {
      para.push(lines[i])
      i++
    }
    out.push({ type: 'paragraph', children: parseInline(para.map((l) => l.trimStart()).join('\n').trimEnd()) })
  }
  return out
}

function isFenceClose(line: string, marker: string): boolean {
  const t = line.trim()
  return indentOf(line) <= 3 && t.length >= marker.length && t[0] === marker[0] && new RegExp(`^\\${marker[0]}+$`).test(t)
}

// ─── inlines ─────────────────────────────────────────────────────────────────────────

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const ALNUM = /[\p{L}\p{N}]/u
const AUTOLINK_RE = /<(https?:\/\/[^\s<>]+)>/iy
const BARE_URL_RE = /https?:\/\/[^\s<>]+/iy

interface InlineCtx {
  depth: number
  inLink: boolean
}

export function parseInline(src: string, ctx: InlineCtx = { depth: 0, inLink: false }): MdInline[] {
  const out: MdInline[] = []
  const n = src.length
  let buf = ''
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf })
    buf = ''
  }
  const pushLink = (url: string, children: MdInline[], title?: string) => {
    const href = safeHref(url)
    flush()
    if (!href) {
      out.push(...children) // unsafe target: keep the words, drop the link
      return
    }
    const link: Extract<MdInline, { type: 'link' }> = { type: 'link', href, children }
    if (title) link.title = title
    out.push(link)
  }

  let i = 0
  while (i < n) {
    const c = src[i]

    if (c === '\\' && i + 1 < n) {
      const nx = src[i + 1]
      if (nx === '\n') {
        flush()
        out.push({ type: 'br' })
        i += 2
        continue
      }
      if (PUNCT.test(nx)) {
        buf += nx
        i += 2
        continue
      }
    }

    if (c === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '')
        flush()
        out.push({ type: 'br' })
      } else {
        buf = buf.replace(/ +$/, '') + ' '
      }
      i++
      while (src[i] === ' ') i++
      continue
    }

    if (c === '`') {
      const run = runLength(src, i, '`')
      const close = findBacktickClose(src, i + run, run)
      if (close >= 0) {
        flush()
        let code = src.slice(i + run, close).replace(/\n/g, ' ')
        if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1)
        out.push({ type: 'code', text: code })
        i = close + run
        continue
      }
      buf += src.slice(i, i + run)
      i += run
      continue
    }

    if (c === '<' && !ctx.inLink) {
      AUTOLINK_RE.lastIndex = i
      const m = AUTOLINK_RE.exec(src)
      if (m) {
        pushLink(m[1], [{ type: 'text', text: m[1] }])
        i += m[0].length
        continue
      }
    }

    if (c === '[' && !ctx.inLink && ctx.depth < MAX_DEPTH) {
      const l = matchLink(src, i)
      if (l) {
        pushLink(l.url, parseInline(l.text, { depth: ctx.depth + 1, inLink: true }), l.title)
        i = l.end
        continue
      }
    }

    if ((c === 'h' || c === 'H') && !ctx.inLink && (i === 0 || !ALNUM.test(src[i - 1]))) {
      BARE_URL_RE.lastIndex = i
      const m = BARE_URL_RE.exec(src)
      if (m) {
        const url = trimUrlTail(m[0])
        pushLink(url, [{ type: 'text', text: url }])
        i += url.length
        continue
      }
    }

    if ((c === '*' || c === '_') && ctx.depth < MAX_DEPTH) {
      const em = matchEmphasis(src, i)
      if (em) {
        flush()
        const children = parseInline(src.slice(em.start, em.end), { depth: ctx.depth + 1, inLink: ctx.inLink })
        out.push(em.strong ? { type: 'strong', children } : { type: 'em', children })
        i = em.close
        continue
      }
      const run = runLength(src, i, c)
      buf += src.slice(i, i + run)
      i += run
      continue
    }

    buf += c
    i++
  }
  flush()
  return out
}

function runLength(src: string, i: number, ch: string): number {
  let j = i
  while (src[j] === ch) j++
  return j - i
}

/** Index of the next backtick run of exactly `run` length at or after `from`, else -1. */
function findBacktickClose(src: string, from: number, run: number): number {
  let j = from
  while (j < src.length) {
    if (src[j] === '`') {
      const r = runLength(src, j, '`')
      if (r === run) return j
      j += r
    } else j++
  }
  return -1
}

/** Strip sentence punctuation a bare URL swallowed, keeping balanced parentheses (Wikipedia links). */
function trimUrlTail(url: string): string {
  let u = url
  for (;;) {
    const last = u[u.length - 1]
    if (/[.,;:!?'"*_]/.test(last)) u = u.slice(0, -1)
    else if (last === ')' && count(u, '(') < count(u, ')')) u = u.slice(0, -1)
    else return u
  }
}

const count = (s: string, ch: string) => s.split(ch).length - 1

/** `[text](url "title")` starting at i; null if it is not a well-formed inline link. */
function matchLink(src: string, i: number): { text: string; url: string; title?: string; end: number } | null {
  let j = i + 1
  let depth = 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) break
    j++
  }
  if (depth !== 0 || src[j + 1] !== '(') return null
  const text = src.slice(i + 1, j)
  let k = j + 2
  while (src[k] === ' ') k++
  let url: string
  if (src[k] === '<') {
    const close = src.indexOf('>', k)
    if (close < 0) return null
    url = src.slice(k + 1, close)
    k = close + 1
  } else {
    let parens = 0
    const s = k
    while (k < src.length && !/\s/.test(src[k])) {
      if (src[k] === '(') parens++
      else if (src[k] === ')') {
        if (parens === 0) break
        parens--
      }
      k++
    }
    url = src.slice(s, k)
  }
  while (src[k] === ' ') k++
  let title: string | undefined
  if (src[k] === '"' || src[k] === "'") {
    const q = src[k]
    const close = src.indexOf(q, k + 1)
    if (close < 0) return null
    title = src.slice(k + 1, close)
    k = close + 1
    while (src[k] === ' ') k++
  }
  if (src[k] !== ')') return null
  return { text, url, title, end: k + 1 }
}

/**
 * Emphasis opened by the delimiter run at i: `**`/`__` → strong, `*`/`_` → em (a run of 3
 * opens strong around an em). The closer is the first run that is not preceded by whitespace
 * and is long enough; `_` must not touch letters on the outside, so snake_case stays text.
 */
function matchEmphasis(src: string, i: number): { strong: boolean; start: number; end: number; close: number } | null {
  const ch = src[i]
  const run = runLength(src, i, ch)
  const after = src[i + run]
  if (after === undefined || /\s/.test(after)) return null
  if (ch === '_' && i > 0 && ALNUM.test(src[i - 1])) return null
  const want = run >= 2 ? 2 : 1
  const start = i + want
  let j = i + run
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') {
      const r = runLength(src, j, '`')
      const close = findBacktickClose(src, j + r, r)
      j = close >= 0 ? close + r : j + r
      continue
    }
    if (c === ch) {
      const L = runLength(src, j, ch)
      const okBefore = !/\s/.test(src[j - 1])
      const tail = src[j + L]
      const okAfter = ch !== '_' || tail === undefined || !ALNUM.test(tail)
      if (okBefore && okAfter && j > start) {
        if (want === 2 && L >= 2) return { strong: true, start, end: j + L - 2, close: j + L }
        if (want === 1 && L !== 2) return { strong: false, start, end: j + L - 1, close: j + L }
      }
      j += L
      continue
    }
    j++
  }
  return null
}

// ─── rendering ───────────────────────────────────────────────────────────────────────

export interface MdClasses {
  h1: string
  h2: string
  h3: string
  h4: string
  h5: string
  h6: string
  p: string
  code: string
  pre: string
  a: string
  ul: string
  ol: string
  li: string
  blockquote: string
  hr: string
  strong: string
  em: string
}

/** Brutalist defaults: mono, hard rules, signal-orange links. */
export const MD_CLASSES: MdClasses = {
  h1: 'mt-3 mb-2 text-[15px] font-bold uppercase tracking-[0.08em] text-bone',
  h2: 'mt-3 mb-2 text-[13px] font-bold uppercase tracking-[0.1em] text-bone',
  h3: 'mt-3 mb-1 text-[12px] font-bold uppercase tracking-[0.12em] text-bone',
  h4: 'mt-2 mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-concrete',
  h5: 'mt-2 mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-concrete',
  h6: 'mt-2 mb-1 text-[10px] uppercase tracking-[0.14em] text-concrete',
  p: 'my-2 leading-relaxed',
  code: 'border border-bone/15 bg-bone/5 px-1 text-ember',
  pre: 'my-2 overflow-x-auto border border-bone/15 bg-bone/5 p-2 text-[11px] leading-snug text-bone',
  a: 'text-signal underline underline-offset-2 hover:text-ember',
  ul: 'my-2 list-[square] pl-5',
  ol: 'my-2 list-decimal pl-6',
  li: 'my-0.5',
  blockquote: 'my-2 border-l-2 border-brass pl-3 text-concrete',
  hr: 'my-3 border-0 border-t border-bone/20',
  strong: 'font-bold text-bone',
  em: 'italic',
}

function renderInlines(nodes: MdInline[], cls: MdClasses, key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`
    switch (n.type) {
      case 'text':
        return n.text
      case 'br':
        return h('br', { key: k })
      case 'code':
        return h('code', { key: k, className: cls.code }, n.text)
      case 'strong':
        return h('strong', { key: k, className: cls.strong }, renderInlines(n.children, cls, k))
      case 'em':
        return h('em', { key: k, className: cls.em }, renderInlines(n.children, cls, k))
      case 'link':
        return h(
          'a',
          { key: k, href: n.href, title: n.title, rel: 'noopener noreferrer', target: '_blank', className: cls.a },
          renderInlines(n.children, cls, k),
        )
    }
  })
}

function renderBlocks(blocks: MdBlock[], cls: MdClasses, key: string, inItem = false): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`
    switch (b.type) {
      case 'heading': {
        const tag = `h${b.level}` as const
        return h(tag, { key: k, className: cls[tag] }, renderInlines(b.children, cls, k))
      }
      case 'paragraph':
        // A list item's leading paragraph renders bare so tight lists stay tight.
        if (inItem && i === 0) return h('span', { key: k }, renderInlines(b.children, cls, k))
        return h('p', { key: k, className: cls.p }, renderInlines(b.children, cls, k))
      case 'code':
        return h(
          'pre',
          { key: k, className: cls.pre, 'data-lang': b.lang ?? undefined },
          h('code', null, b.text),
        )
      case 'blockquote':
        return h('blockquote', { key: k, className: cls.blockquote }, renderBlocks(b.children, cls, k))
      case 'hr':
        return h('hr', { key: k, className: cls.hr })
      case 'list':
        return h(
          b.ordered ? 'ol' : 'ul',
          { key: k, className: b.ordered ? cls.ol : cls.ul, start: b.ordered && b.start !== 1 ? b.start : undefined },
          b.items.map((item, j) => h('li', { key: `${k}.${j}`, className: cls.li }, renderBlocks(item, cls, `${k}.${j}`, true))),
        )
    }
  })
}

/** Markdown source → React nodes. Safe by construction: no HTML pass, http(s) links only. */
export function renderMarkdown(src: string, classes: MdClasses = MD_CLASSES): ReactNode[] {
  return renderBlocks(parseMarkdown(src), classes, 'md')
}

/** Rendered Markdown in a div; re-parses only when the source changes. */
export function Markdown(props: { source: string; className?: string; classes?: MdClasses }): ReactNode {
  const { source, classes } = props
  const body = useMemo(() => renderMarkdown(source, classes), [source, classes])
  return h('div', { className: props.className }, body)
}
