// Group names and marks are user content. Return plain strings for textContent.
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const isEmoji = value => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
const sameMark = (a, b) => a.replace(/[\ufe0e\ufe0f]/g, '') === b.replace(/[\ufe0e\ufe0f]/g, '')

const iconEmoji = {
  folder: '📁', people: '👥', graduation: '🎓', planet: '🪐', sparkle: '✨', books: '📚',
  globe: '🌐', heart: '❤️', coffee: '☕', briefcase: '💼', camera: '📷', music: '🎵',
  leaf: '🌿', lightning: '⚡', code: '💻', mountains: '🏔️',
}

function fallback(name) {
  if (/\bbanks?\b/i.test(name)) return '🏦'
  if (/venture capital|\binvest(?:or|ment)?s?\b|\bvc\b/i.test(name)) return '💸'
  if (/columbia|university|school|college|academ/i.test(name)) return '🎓'
  if (/\b(?:ai|labs?|research)\b/i.test(name)) return '🔬'
  if (/cosmos|space|astro/i.test(name)) return '🪐'
  if (/journal|news|writ/i.test(name)) return '📚'
  if (/friend|family|close/i.test(name)) return '❤️'
  if (/founder|business|work|startup/i.test(name)) return '💼'
  if (/art|photo|design|creat/i.test(name)) return '📷'
  if (/tech|engineer|develop|code/i.test(name)) return '💻'
  return '👥'
}

export function groupDisplay(group) {
  const name = (group.name || '').trim()
  const saved = (group.emoji || '').trim()
  const characters = [...segments.segment(name)].map(part => part.segment)
  const first = characters[0] || '', last = characters.at(-1) || ''
  for (const [mark, atStart] of [[first, true], [last, false]]) {
    if (mark && (isEmoji(mark) || saved && sameMark(mark, saved)) && (!saved || sameMark(mark, saved))) {
      const label = (atStart ? name.slice(mark.length) : name.slice(0, -mark.length)).trim()
      return label ? { icon: saved || mark, name: label } : { icon: '', name }
    }
  }
  if (saved && !characters.some(mark => sameMark(mark, saved))) return { icon: saved, name }
  if (isEmoji(name) || saved) return { icon: '', name }
  return { icon: iconEmoji[group.icon] || fallback(name), name }
}
