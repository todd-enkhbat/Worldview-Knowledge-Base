import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, parseInline, parseMarkdown, renderMarkdown, safeHref, type MdClasses } from '../../src/hud/markdown.ts'

// Empty class map so assertions read as plain HTML.
const BARE: MdClasses = {
  h1: '', h2: '', h3: '', h4: '', h5: '', h6: '', p: '', code: '', pre: '', a: '', ul: '', ol: '', li: '',
  blockquote: '', hr: '', strong: '', em: '',
}
const html = (md: string) =>
  renderToStaticMarkup(createElement('div', null, renderMarkdown(md, BARE)))
    .replace(/^<div>|<\/div>$/g, '')
    .replace(/ class=""/g, '')

describe('escaping', () => {
  it('renders raw HTML as text', () => {
    const out = html('<script>alert(1)</script>')
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(out).not.toContain('<script')
  })

  it('escapes attribute-style payloads and entities', () => {
    const out = html('<img src=x onerror="alert(1)"> & &amp;')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &amp;amp;')
  })

  it('escapes inside code spans and code blocks', () => {
    expect(html('`<b>x</b>`')).toBe('<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>')
    expect(html('```\n<b>**x**</b>\n```')).toBe('<pre><code>&lt;b&gt;**x**&lt;/b&gt;</code></pre>')
  })

  it('honours backslash escapes', () => {
    expect(html('\\*not em\\* \\# \\[x\\]')).toBe('<p>*not em* # [x]</p>')
  })
})

describe('headings and paragraphs', () => {
  it('renders ATX headings 1–6 with optional closing hashes', () => {
    expect(html('# One')).toBe('<h1>One</h1>')
    expect(html('###### Six ##')).toBe('<h6>Six</h6>')
    expect(html('## C# notes')).toBe('<h2>C# notes</h2>')
  })

  it('does not treat #hashtags or 7 hashes as headings', () => {
    expect(html('#hashtag')).toBe('<p>#hashtag</p>')
    expect(html('####### seven')).toBe('<p>####### seven</p>')
  })

  it('splits paragraphs on blank lines and joins soft breaks with a space', () => {
    expect(html('a\nb\n\nc')).toBe('<p>a b</p><p>c</p>')
  })

  it('turns two trailing spaces or a backslash into a hard break', () => {
    expect(html('a  \nb\\\nc')).toBe('<p>a<br/>b<br/>c</p>')
  })

  it('lets a heading interrupt a paragraph', () => {
    expect(html('text\n# Head')).toBe('<p>text</p><h1>Head</h1>')
  })
})

describe('emphasis and code', () => {
  it('renders bold, italic and both', () => {
    expect(html('**b** __b__ *i* _i_')).toBe('<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em></p>')
    expect(html('***both***')).toBe('<p><strong><em>both</em></strong></p>')
    expect(html('**bold *and em* inside**')).toBe('<p><strong>bold <em>and em</em> inside</strong></p>')
    expect(html('*em with **strong** inside*')).toBe('<p><em>em with <strong>strong</strong> inside</em></p>')
  })

  it('keeps snake_case, lone stars and spaced delimiters literal', () => {
    expect(html('snake_case_name')).toBe('<p>snake_case_name</p>')
    expect(html('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>')
    expect(html('**unclosed')).toBe('<p>**unclosed</p>')
  })

  it('does not parse emphasis inside code spans', () => {
    expect(html('`**x**` and ``a ` b``')).toBe('<p><code>**x**</code> and <code>a ` b</code></p>')
  })

  it('renders fenced code with a language tag and keeps indentation', () => {
    expect(html('~~~ts\nconst a = 1\n  b()\n~~~')).toBe('<pre data-lang="ts"><code>const a = 1\n  b()</code></pre>')
  })

  it('runs an unclosed fence to the end of the document', () => {
    expect(html('```\nx\n\ny')).toBe('<pre><code>x\n\ny</code></pre>')
  })
})

describe('links', () => {
  it('allows http and https with rel=noopener', () => {
    expect(html('[site](https://example.com/a?b=1 "Title")')).toBe(
      '<p><a href="https://example.com/a?b=1" title="Title" rel="noopener noreferrer" target="_blank">site</a></p>',
    )
    expect(html('[x](http://example.com)')).toContain('href="http://example.com/"')
  })

  it('drops every other scheme but keeps the label', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '/relative', '//evil.com', 'mailto:a@b.c']) {
      const out = html(`[label](${url})`)
      expect(out, url).toBe('<p>label</p>')
    }
  })

  it('cannot break out of the href attribute', () => {
    const out = html('[x](https://a.com/"onmouseover=alert(1))')
    expect(out).not.toMatch(/"\s*onmouseover/)
    expect(out).toContain('href="https://a.com/%22onmouseover=alert(1)"')
  })

  it('autolinks <url> and bare urls, trimming trailing punctuation', () => {
    expect(html('<https://a.com/x>')).toBe('<p><a href="https://a.com/x" rel="noopener noreferrer" target="_blank">https://a.com/x</a></p>')
    expect(html('see https://a.com/wiki/Foo_(bar).')).toBe(
      '<p>see <a href="https://a.com/wiki/Foo_(bar)" rel="noopener noreferrer" target="_blank">https://a.com/wiki/Foo_(bar)</a>.</p>',
    )
    expect(html('<javascript:alert(1)>')).toBe('<p>&lt;javascript:alert(1)&gt;</p>')
  })

  it('renders emphasis inside link text but never nests links', () => {
    const out = html('[**b** https://x.com](https://a.com)')
    expect(out).toBe('<p><a href="https://a.com/" rel="noopener noreferrer" target="_blank"><strong>b</strong> https://x.com</a></p>')
  })

  it('safeHref normalises or rejects', () => {
    expect(safeHref(' https://A.com ')).toBe('https://a.com/')
    expect(safeHref('https://')).toBeNull()
    expect(safeHref('ftp://a.com')).toBeNull()
    expect(safeHref('java\nscript:alert(1)')).toBeNull()
  })
})

describe('lists and quotes', () => {
  it('renders unordered lists (tight items without <p>)', () => {
    expect(html('- a\n- b\n* c')).toBe('<ul><li><span>a</span></li><li><span>b</span></li><li><span>c</span></li></ul>')
  })

  it('renders ordered lists with a start number', () => {
    expect(html('3. a\n4. b')).toBe('<ol start="3"><li><span>a</span></li><li><span>b</span></li></ol>')
    expect(html('1) a')).toBe('<ol><li><span>a</span></li></ol>')
  })

  it('nests lists by indentation and continues lazy lines', () => {
    expect(html('- a\n  - b\n  - c\n- d\ncontinued')).toBe(
      '<ul><li><span>a</span><ul><li><span>b</span></li><li><span>c</span></li></ul></li><li><span>d continued</span></li></ul>',
    )
  })

  it('keeps loose lists together across blank lines', () => {
    expect(html('- a\n\n- b')).toBe('<ul><li><span>a</span></li><li><span>b</span></li></ul>')
  })

  it('does not let a mid-sentence number start a list', () => {
    expect(html('We moved in\n2019. Then left')).toBe('<p>We moved in 2019. Then left</p>')
  })

  it('renders blockquotes with nested markdown', () => {
    expect(html('> quote **b**\n> - item\n>> deeper')).toBe(
      '<blockquote><p>quote <strong>b</strong></p><ul><li><span>item</span></li></ul><blockquote><p>deeper</p></blockquote></blockquote>',
    )
  })

  it('renders thematic breaks', () => {
    expect(html('a\n\n---\n\n* * *')).toBe('<p>a</p><hr/><hr/>')
  })
})

describe('robustness', () => {
  it('survives hostile nesting and long delimiter runs', () => {
    expect(() => html('>'.repeat(5000) + ' x')).not.toThrow()
    expect(() => html('- '.repeat(2000) + 'x')).not.toThrow()
    expect(() => html('['.repeat(5000) + 'x')).not.toThrow()
    expect(() => html('*a '.repeat(3000))).not.toThrow()
    expect(() => html('`'.repeat(3000))).not.toThrow()
  })

  it('handles empty input and CRLF', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(html('a\r\nb\r\n\r\nc')).toBe('<p>a b</p><p>c</p>')
  })

  it('exposes the inline AST', () => {
    expect(parseInline('a **b**')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
    ])
  })

  it('Markdown component wraps output in a div', () => {
    const out = renderToStaticMarkup(createElement(Markdown, { source: '# t', className: 'x', classes: BARE }))
    expect(out).toBe('<div class="x"><h1 class="">t</h1></div>')
  })
})
