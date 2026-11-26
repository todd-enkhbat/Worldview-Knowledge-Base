// Runs only after "Read this form" in the floating helper. Keep the script
// self-contained so it can run in an isolated world without page libraries.
export function readApplicationForm() {
  const sensitive =
    /pass(?:word|code)|security code|social security|credit card|debit card|cardholder|card number|cvv|verification code|routing number|bank account|one.time.code|cc[-_ ]|tax id/i
  const answers = [],
    grouped = new Map()
  for (const field of document.querySelectorAll('textarea,input,select')) {
    const type = field.type || ''
    if (['radio', 'checkbox'].includes(type) && field.getClientRects().length && !field.disabled) {
      const box = field.closest('fieldset,[role="group"],[role="radiogroup"]')
      const label = (
        box?.querySelector('legend')?.innerText ||
        box?.getAttribute('aria-label') ||
        field.name ||
        ''
      ).trim()
      const option = Array.from(field.labels || [], (node) => node.innerText)
        .join(' ')
        .trim()
      if (label && option && !sensitive.test(label + ' ' + option + ' ' + field.name)) {
        if (!grouped.has(label)) grouped.set(label, [])
        if (field.checked) grouped.get(label).push(option)
      }
      continue
    }
    if (
      !['textarea', 'text', 'url', 'select-one', 'select-multiple', 'search'].includes(type) ||
      !field.getClientRects().length ||
      field.disabled
    )
      continue
    const question =
      Array.from(field.labels || [], (node) => node.innerText)
        .join(' ')
        .trim() ||
      field.getAttribute('aria-label') ||
      (field.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(' ') ||
      field.placeholder ||
      field.name
    if (
      !question ||
      sensitive.test(
        [question, field.name, field.id, field.autocomplete, field.getAttribute('placeholder')].join(' ')
      )
    )
      continue
    const instructions = (field.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join('\n')
    const answer =
      field.tagName === 'SELECT'
        ? Array.from(field.selectedOptions, (o) => (o.value ? o.text : '')).join('\n')
        : field.value
    answers.push({
      question: [question, instructions].filter(Boolean).join('\n').slice(0, 8000),
      answer: answer.slice(0, 100000)
    })
    if (answers.length >= 180) break
  }
  for (const [question, selected] of grouped)
    if (answers.length < 180)
      answers.push({ question: question.slice(0, 8000), answer: selected.join('\n').slice(0, 100000) })
  const site = document.querySelector('meta[property="og:site_name"]')?.content || ''
  return {
    organization: site,
    opportunity: document.querySelector('h1')?.innerText || document.title,
    source: location.origin + location.pathname,
    answers
  }
}

