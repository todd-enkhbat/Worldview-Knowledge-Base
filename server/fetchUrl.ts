// URL intake (milestone 1): fetch a page server side and reduce it to readable text, so the
// chat can hand it to Claude and keep it as the note's source. Only http(s); a 5 MB cap and
// a 15 s timeout. Plain-text and markdown pass through; HTML loses scripts, styles, nav and
// tags, with block elements turned into line breaks.

const MAX_BYTES = 5 * 1024 * 1024
const MAX_TEXT = 200_000

export interface FetchedPage {
  kind: 'web' | 'youtube'
  url: string
  title: string
  text: string
  contentType: string
  truncated: boolean
}

export async function fetchReadable(raw: string, f: typeof fetch = fetch): Promise<FetchedPage> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('That is not a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be read.')
  if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(url.hostname)) return youtube(url, f)
  const res = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.5' } })
  if (!res.ok) throw new Error(`The page answered ${res.status} ${res.statusText}.`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!/text\/|application\/(xhtml|xml|json)/.test(contentType)) throw new Error(`Cannot read ${contentType || 'this kind of file'} from a link yet; download it and drop it in instead.`)
  const buf = await res.arrayBuffer()
  const body = new TextDecoder().decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf)
  const isHtml = /html|xml/.test(contentType)
  const title = (isHtml && decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? '')) || url.hostname + url.pathname
  let text = isHtml ? htmlToText(body) : body
  const truncated = text.length > MAX_TEXT || buf.byteLength > MAX_BYTES
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT)
  return { kind: 'web', url: res.url || url.href, title: title.slice(0, 200), text, contentType, truncated }
}

/** A YouTube link through oEmbed: title and channel, not the watch page's script soup. */
async function youtube(url: URL, f: typeof fetch): Promise<FetchedPage> {
  const res = await f(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'That video is private or cannot be embedded.' : `YouTube answered ${res.status}.`)
  const o = (await res.json()) as { title?: string; author_name?: string; author_url?: string }
  const title = o.title ?? 'YouTube video'
  const text = `A YouTube video: "${title}"${o.author_name ? ` by ${o.author_name}` : ''}. It can be embedded in a note and played there; you cannot watch it, so ask what it means to them.`
  return { kind: 'youtube', url: url.href, title, text, contentType: 'application/json', truncated: false }
}

export function htmlToText(html: string): string {
  const main = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html
  return decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/blockquote)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(+n)} `)
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return named[e.toLowerCase()] ?? m
  })
}
