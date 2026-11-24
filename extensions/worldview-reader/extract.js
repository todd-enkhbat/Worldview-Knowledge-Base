/** Self-contained so Chrome can serialize this function into the explicitly chosen tab. */
export function extractArticle(doc = document) {
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body
  if (!root) throw new Error('This page has no readable document.')
  const forbidden = 'script,style,noscript,nav,footer,header,form,button,textarea,input,select,[hidden],[aria-hidden="true"]'
  const walker = doc.createTreeWalker(root, 4), segments = []
  let node, text = '', previousBlock = null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || parent.closest(forbidden)) continue
    let hidden = false
    for (let element = parent; element && root.contains(element); element = element.parentElement) {
      const style = doc.defaultView?.getComputedStyle(element)
      if (style?.display === 'none' || style?.visibility === 'hidden') { hidden = true; break }
      if (element === root) break
    }
    if (hidden || !node.nodeValue) continue
    const block = parent.closest('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td') ?? root
    if (previousBlock && block !== previousBlock && node.nodeValue.trim()) text += '\n\n'
    const start = text.length; text += node.nodeValue
    segments.push({ node, start, end: text.length }); if (node.nodeValue.trim()) previousBlock = block
    if (text.length > 512 * 1024) throw new Error('This article is too large. Paste a smaller excerpt into Worldview instead.')
  }
  const leading = text.length - text.trimStart().length
  text = text.trim()
  if (!text || new TextEncoder().encode(text).byteLength > 512 * 1024) throw new Error('No readable article text was found, or it exceeds 512 KiB.')
  let selection = null
  const selected = doc.getSelection()
  if (selected?.rangeCount && !selected.isCollapsed) {
    const range = selected.getRangeAt(0)
    if (root.contains(range.commonAncestorContainer)) {
      const included = segments.filter((segment) => range.intersectsNode(segment.node))
      if (included.length) {
        const first = included[0], last = included.at(-1)
        const start = Math.max(0, first.start + (range.startContainer === first.node ? range.startOffset : 0) - leading)
        const end = Math.min(text.length, last.end - (range.endContainer === last.node ? last.node.length - range.endOffset : 0) - leading)
        const quote = text.slice(start, end)
        if (quote.trim() && quote.length <= 20_000) selection = { quote, start, end, prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80) }
      }
    }
  }
  return { url: doc.location.href, title: (doc.title || root.querySelector('h1')?.textContent || 'Saved article').trim().slice(0, 300), text, selection }
}
