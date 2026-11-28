const sources = ['All events', 'Google Calendar', 'Luma', 'Partiful', 'Saved']
const providerMarks = {
  'Google Calendar': ['31', 'google'],
  Luma: ['✳', 'luma'],
  Partiful: ['P', 'partiful'],
  Saved: ['W', 'saved'],
}
const kinds = [['event', 'Event'], ['meeting', 'Meeting'], ['call', 'Call'], ['email', 'Email'], ['message', 'Message'], ['introduction', 'Introduction']]

export function renderReaderEvents(panel, { request, save, state }) {
  const doc = panel.ownerDocument
  const element = (tag, content = '', className = '') => {
    const item = doc.createElement(tag)
    item.textContent = content
    item.className = className
    return item
  }
  const action = (label, handler, className = '') => {
    const item = element('button', label, className)
    item.type = 'button'
    item.addEventListener('click', handler)
    return item
  }
  const label = (caption, control) => {
    const field = element('label', caption)
    field.append(control)
    return field
  }
  const choices = (caption, values, selected, change) => {
    const group = element('div', '', 'reader-event-choices')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', caption)
    const buttons = values.map(([value, text]) => action(text, () => {
      buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(values[index][0] === value)))
      change(value)
    }))
    buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(values[index][0] === selected)))
    group.append(...buttons)
    return group
  }

  const picker = element('section', '', 'reader-event-picker')
  const title = element('h3', 'Find an event')
  const header = element('header', '', 'reader-event-header')
  const results = element('ul', '', 'reader-event-results')
  const feedback = element('p', '', 'reader-event-feedback')
  feedback.setAttribute('role', 'status')
  const form = element('form', '', 'reader-event-form')
  form.hidden = true
  const showForm = action('New event', () => {
    form.hidden = !form.hidden
    browse.hidden = !form.hidden
    showForm.setAttribute('aria-expanded', String(!form.hidden))
    if (!form.hidden) {
      yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      subject.focus()
    }
  }, 'reader-event-primary')
  showForm.setAttribute('aria-expanded', 'false')
  header.append(title, showForm)

  const subject = element('input')
  subject.required = true
  subject.maxLength = 300
  subject.placeholder = 'Coffee, conference, or meeting'
  const dateInput = element('input')
  dateInput.type = 'datetime-local'
  const dateField = label('Date and time', dateInput)
  dateField.hidden = true
  let timing = 'today', kind = 'event', yesterday = new Date()
  const dateChoices = choices('When', [['today', 'Today'], ['yesterday', 'Yesterday'], ['custom', 'Pick date & time']], timing, value => {
    timing = value
    dateField.hidden = value !== 'custom'
    dateInput.required = !dateField.hidden
    if (!dateField.hidden) dateInput.focus()
  })
  const notes = element('details')
  const body = element('textarea')
  body.maxLength = 12000
  body.rows = 3
  notes.append(element('summary', 'Add context'), label('Context', body))
  const submit = element('button', 'Create & attach', 'reader-event-primary')
  submit.type = 'submit'
  submit.disabled = true
  subject.addEventListener('input', () => { submit.disabled = !subject.value.trim() })
  form.append(label('Title', subject), dateChoices, dateField,
    choices('Interaction type', kinds, kind, value => {
      kind = value
      submit.textContent = kind === 'event' ? 'Create & attach' : 'Log ' + (kind === 'introduction' ? 'introduction' : kind)
    }), notes, submit)
  form.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    form.hidden = true
    browse.hidden = false
    showForm.setAttribute('aria-expanded', 'false')
    showForm.focus()
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const date = timing === 'custom' ? new Date(dateInput.value).getTime() : timing === 'yesterday' ? yesterday.getTime() : null
    if (timing === 'custom' && !Number.isFinite(date)) return
    // Keep the timestamp stable across retries of the same draft.
    void save({ action: 'interaction', title: subject.value, date, body: body.value, kind },
      kind === 'event' ? 'Event saved. You can attach it from another record.' : 'Interaction saved.')
  })

  const search = element('input', '', 'reader-event-search')
  search.type = 'search'
  search.placeholder = 'Search events or calendars…'
  search.setAttribute('aria-label', 'Search events')
  search.value = state.query ?? ''
  search.addEventListener('input', () => { state.query = search.value; renderResults() })
  const filters = choices('Event source', sources.map(source => [source, source]), state.source ?? 'All events', value => {
    state.source = value
    renderResults()
  })
  const refresh = action('Refresh', () => { void load(true) }, 'reader-event-refresh')
  const footer = element('div', '', 'reader-event-header reader-event-footer')
  footer.append(feedback, refresh)
  const browse = element('div', '', 'reader-event-browse')
  browse.append(search, filters, results, footer)
  picker.append(header, form, browse)
  panel.append(picker)

  function renderResults() {
    const words = (state.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const visible = (state.events ?? []).filter(row =>
      !state.attached.has(row.id) &&
      (!state.source || state.source === 'All events' || row.source === state.source) &&
      words.every(word => (row.title + ' ' + row.source + ' ' + (row.calendar ?? '')).toLowerCase().includes(word)))
    results.replaceChildren()
    results.hidden = !visible.length
    for (const row of visible.slice(0, 20)) {
      const item = element('li', '', 'reader-event-result')
      const date = row.date === null ? null : new Date(row.date)
      const zone = row.allDay ? { timeZone: 'UTC' } : {}
      const tile = element('div', '', 'reader-event-date')
      tile.setAttribute('aria-hidden', 'true')
      tile.append(element('span', date?.toLocaleDateString(undefined, { month: 'short', ...zone }) ?? 'Date'),
        element('strong', date?.toLocaleDateString(undefined, { day: 'numeric', ...zone }) ?? '—'))
      const text = element('div', '', 'reader-event-text')
      const when = date?.toLocaleString(undefined, { dateStyle: 'medium', ...(row.allDay ? zone : { timeStyle: 'short' }) })
      const provenance = element('span', '', 'reader-event-provenance')
      const [symbol, brand] = providerMarks[row.source] ?? providerMarks.Saved
      const mark = element('span', symbol, 'reader-provider-mark reader-provider-' + brand)
      mark.setAttribute('aria-hidden', 'true')
      provenance.append(mark, element('span', row.source))
      text.append(element('strong', row.title), provenance,
        element('small', [when, row.calendar, row.matched && 'Contact email matched'].filter(Boolean).join(' · ')))
      const attach = action('Attach', () => void save({ action: 'link-event', eventId: row.id }, 'Event attached.'))
      attach.setAttribute('aria-label', 'Attach ' + row.title)
      item.append(tile, text, attach)
      results.append(item)
    }
    refresh.disabled = !!state.loading
    feedback.textContent = state.loading ? 'Checking connected calendars…' :
      state.error ? 'Calendar lookup failed. Refresh to try again.' :
      state.calendarStatus === 'partial' ? 'Some calendar results are unavailable or outside the lookup limit.' :
      state.calendarStatus === 'disconnected' ? 'Connect Google Calendar in Worldview to see more events.' :
      !visible.length ? (words.length || state.source && state.source !== 'All events' ? 'No events match these filters.' : 'No events to suggest yet. Create one to reuse it later.') :
      visible.length > 20 ? 'Showing 20 events. Search to narrow the list.' : ''
  }

  async function load(force = false) {
    if (force || !state.loading && !state.loaded) {
      state.error = false
      state.loading = (async () => {
        try {
          if (!state.loaded) {
            const local = await request({ action: 'event-suggestions' })
            state.events = local.events
            renderResults()
          }
          const online = await request({ action: 'event-suggestions', online: true })
          state.events = online.events
          state.calendarStatus = online.calendarStatus
        } catch { state.error = true }
        finally { state.loaded = true; state.loading = null }
      })()
    }
    renderResults()
    await state.loading
    renderResults()
  }

  void load()
}
