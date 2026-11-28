import { renderReaderEvents } from './reader-events-ui.js'

const personFields = [
  ['fullName','Name'], ['firstName','First name'], ['lastName','Last name'], ['jobTitle','Job title'], ['status','Status'],
  ['emails','Email addresses','list'], ['phones','Phone numbers','list'], ['location','Location'], ['addresses','Addresses','list'],
  ['urls','Websites & profiles','list'], ['description','Description','long'], ['tags','Tags','list'],
]
const fields = [
  ['name', 'Name'], ['status', 'Status'], ['organizationType', 'Organization type', 'type'],
  ['emails', 'Email addresses', 'list'], ['phones', 'Phone numbers', 'list'],
  ['location', 'Location'], ['addresses', 'Addresses', 'list'],
  ['urls', 'Websites & profiles', 'list'], ['domain', 'Website domain'], ['description', 'Description', 'long'], ['tagline', 'Tagline'],
  ['industry', 'Industry'], ['employeeRange', 'Employee range'], ['foundationYear', 'Foundation year', 'number'],
  ['fundingRaised', 'Funding raised', 'number'], ['lastFundingDate', 'Last funding date', 'date'], ['tags', 'Tags', 'list'],
]
const displayDate = value => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
const pretty = value => typeof value === 'string' || typeof value === 'number' ? String(value) :
  value && typeof value === 'object' ? String(value.label ?? value.name ?? value.value ?? value.address ?? value.formattedAddress ?? '') : ''
const inputValue = (value, kind) => {
  if (kind === 'list') return (Array.isArray(value) ? value : [value]).map(pretty).filter(Boolean).join('\n')
  if (kind === 'date') {
    const date = typeof value === 'number' ? value : Date.parse(pretty(value))
    return Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : ''
  }
  return pretty(value)
}

export function mountOrganizationEditor(host, { request, personLink, companyLink, onChange, actionHost, entityType = 'company' }) {
  const eventState = { attached: new Set() }
  const person = entityType === 'person'
  const sections = ['Details', person ? 'Connections' : 'People', 'Interactions', 'Notes', 'Tasks', 'History']
  const doc = host.ownerDocument
  const node = (tag, text = '') => {
    const item = doc.createElement(tag)
    item.textContent = text
    return item
  }
  const button = (title, click) => {
    const item = node('button', title)
    item.type = 'button'
    if (click) item.addEventListener('click', click)
    return item
  }
  const organizationIdentity = (name, detail, logo, open, company) => {
    const row = node(open ? 'button' : 'div')
    if (open) {
      row.type = 'button'
      row.addEventListener('click', open)
    }
    row.className = 'reader-company-identity'
    const mark = node('span', name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase())
    mark.className = 'reader-company-mark'
    mark.setAttribute('aria-hidden', 'true')
    try {
      const url = new URL(logo)
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const image = node('img')
        image.alt = ''
        image.loading = 'lazy'
        image.referrerPolicy = 'no-referrer'
        image.addEventListener('error', () => image.remove())
        image.src = url.href
        mark.append(image)
      }
    } catch { /* Initials keep organizations recognizable without an image. */ }
    if (company?.logoAssetId) {
      void request({ action: 'organization-logo', companyId: company.id }).then(result => {
        if (!live || !/^data:image\/(png|jpeg|webp);base64,/.test(result.logo || '')) return
        const image = node('img')
        image.alt = ''
        image.src = result.logo
        image.addEventListener('error', () => image.remove())
        mark.replaceChildren(image)
      }).catch(() => {})
    }
    const copy = node('span')
    copy.className = 'reader-company-copy'
    copy.append(node('strong', name))
    if (detail) copy.append(node('small', detail))
    row.append(mark, copy)
    return row
  }
  const options = (select, values) => {
    for (const [value, label] of values) {
      const option = node('option', label)
      option.value = value
      select.append(option)
    }
  }
  const field = (form, label, kind = 'text') => {
    const wrap = node('label', label)
    const control = node(kind === 'long' || kind === 'list' ? 'textarea' : kind === 'select' ? 'select' : 'input')
    if (control.tagName === 'INPUT') control.type = kind
    if (control.tagName === 'TEXTAREA') control.rows = kind === 'list' ? 2 : 3
    wrap.append(control)
    form.append(wrap)
    return control
  }
  const submit = (form, title, callback) => {
    const control = button(title)
    control.type = 'submit'
    form.append(control)
    form.addEventListener('submit', event => { event.preventDefault(); void callback() })
    return control
  }
  const addMeta = (where, text) => { if (text) where.append(node('small', text)) }
  const pending = new Map()
  let model, active = 'Details', busy = false, live = true, editing = false, inlineActive = null
  const status = node('p')
  status.setAttribute('role', 'status')
  const toolbar = node('div')
  toolbar.className = 'reader-record-tools'
  const enrich = button('✧ Enrich', () => void run({ action: 'enrich' }, '', active))
  enrich.setAttribute('aria-label', 'Enrich missing details')
  enrich.title = 'Fill missing details using saved profile evidence and the official website'
  enrich.disabled = true
  toolbar.append(enrich)
  const nav = node('nav')
  nav.className = 'organization-tabs'
  nav.setAttribute('aria-label', 'Organization sections')
  const panels = new Map()
  const tabs = sections.map(title => {
    const tab = button(title, () => select(title))
    const panel = node('section')
    panel.setAttribute('aria-label', title)
    panels.set(title, panel)
    nav.append(tab)
    return [title, tab]
  })
  host.replaceChildren(...(actionHost ? [] : [toolbar]), nav, status, ...panels.values())
  if (actionHost) actionHost.append(toolbar)

  function select(title) {
    if (inlineActive && title !== active) { status.textContent = 'Save or cancel your field edit first.'; inlineActive.querySelector('input,textarea')?.focus(); return }
    if (title !== active && !busy) status.textContent = ''
    active = title
    const edit = toolbar.querySelector('.reader-edit-details')
    if (edit) edit.hidden = title !== 'Details'
    for (const [key, tab] of tabs) {
      tab.setAttribute('aria-pressed', String(key === title))
      panels.get(key).hidden = key !== title
    }
    if (!panels.get(title).children.length && model) render(title)
  }

  async function run(payload, message, pane = active) {
    if (busy) return
    if (payload?.action === 'enrich' && (inlineActive || panels.get('Details').querySelector('.organization-details-form')?.dataset.dirty === 'true')) {
      select('Details')
      status.textContent = 'Save your edits before enriching this record.'
      return
    }
    busy = true
    enrich.disabled = true
    status.textContent = payload?.action === 'enrich' ? 'Checking saved profile and official website…' : payload ? 'Saving…' : 'Opening saved record…'
    const panel = panels.get(pane)
    const controls = [...(payload?.action === 'enrich' ? host : panel).querySelectorAll('input,textarea,button,select')].filter(control => !control.disabled)
    for (const control of controls) control.disabled = true
    try {
      const key = payload && JSON.stringify(payload)
      if (key && !pending.has(key)) pending.set(key, crypto.randomUUID())
      const focusKey = inlineActive?.dataset.inlineKey
      const updated = await request(key ? { ...payload, requestId: pending.get(key) } : {})
      if (key) pending.delete(key)
      if (!live) return
      inlineActive = null
      model = updated
      if (payload?.action === 'link-event') eventState.attached.add(payload.eventId)
      for (const [title, tab] of tabs) {
        const key = title.toLowerCase()
        const count = model[key]?.length
        tab.textContent = typeof count === 'number' && title !== 'History' ? title + ' ' + count : title
        tab.setAttribute('aria-label', title)
      }
      onChange(model)
      const detailPanel = panels.get('Details')
      const savedForm = ['group', 'field'].includes(payload?.action) ? detailPanel.querySelector('.reader-details-editor') : null
      if (payload?.action === 'enrich') {
        const detailsForm = detailPanel.querySelector('.organization-details-form')
        if (detailsForm?.dataset.dirty === 'true') {
          detailPanel.prepend(node('p', 'The record updated while you were editing. Save or reopen Reader to review the latest details.'))
        } else render('Details')
        const receipt = updated.enrichment
        const summary = receipt?.fields?.length ? 'Filled ' + receipt.fields.length + ' missing ' + (receipt.fields.length === 1 ? 'field.' : 'fields.') : 'No verified missing details found.'
        status.textContent = [summary, ...(receipt?.sources || []).map(source => source.provider + ' · ' + source.status)].join(' ')
      } else {
        const focusWasInPanel = panel.contains(doc.activeElement)
        render(pane)
        if (focusWasInPanel && pane === 'Interactions') panel.querySelector('.reader-event-search').focus()
        if (savedForm?.querySelector('form')?.dataset.dirty === 'true') detailPanel.querySelector('.reader-details-editor').replaceWith(savedForm)
        status.textContent = message
        if (focusKey) [...panel.querySelectorAll('[data-inline-key]')].find(item => item.dataset.inlineKey === focusKey)?.querySelector('button')?.focus()
      }
    } catch (error) {
      if (!live) return
      status.textContent = error.message
      if (!model) panel.replaceChildren(button('Retry', () => void run(undefined, '', pane)))
    } finally {
      busy = false
      enrich.disabled = !model
      for (const control of controls) control.disabled = false
    }
  }

  function inlineEditor(key, label, value, kind, payload, triggerContent) {
    const wrap = node('div')
    wrap.className = 'reader-inline-field'
    wrap.dataset.inlineKey = key
    const emptyLabel = { 'Email addresses': 'email', 'Phone numbers': 'phone', 'Websites & profiles': 'website or profile' }[label] || label.toLowerCase()
    const trigger = button(value || 'Add ' + emptyLabel, () => {
      if (busy || editing) { status.textContent = 'Finish editing details first.'; return }
      if (inlineActive) { inlineActive.querySelector('input,textarea')?.focus(); return }
      const form = node('form')
      form.className = 'reader-inline-form'
      const input = field(form, label, kind === 'long' ? 'long' : kind === 'number' || kind === 'date' || kind === 'email' || kind === 'tel' ? kind : 'text')
      input.name = key
      input.autocomplete = kind === 'email' ? 'email' : kind === 'tel' ? 'tel' : 'off'
      if (kind === 'email') input.spellcheck = false
      input.value = value
      const actions = node('div')
      actions.className = 'reader-inline-actions'
      const save = button('Save')
      save.type = 'submit'
      save.className = 'primary'
      const cancel = button('Cancel', () => {
        if (busy) return
        inlineActive = null
        form.remove()
        trigger.hidden = false
        trigger.focus()
        status.textContent = ''
      })
      actions.append(save, cancel)
      form.append(actions)
      form.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.click() }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit() }
      })
      form.addEventListener('submit', event => {
        event.preventDefault()
        if (busy) return
        if (input.value === value) { cancel.click(); return }
        const revision = model.record.revision
        void run({ ...payload(input.value.trim()), revision }, label + ' saved.', 'Details')
      })
      trigger.hidden = true
      wrap.append(form)
      inlineActive = wrap
      input.focus()
    })
    trigger.className = 'reader-inline-value' + (!value ? ' reader-inline-empty' : '')
    trigger.setAttribute('aria-label', (value ? 'Edit ' : 'Add ') + label.toLowerCase())
    trigger.title = 'Click to edit ' + label.toLowerCase()
    if (triggerContent) trigger.replaceChildren(triggerContent)
    wrap.append(trigger)
    return wrap
  }

  function renderDetails(panel) {
    if (person) {
      const cards = node('div')
      cards.className = 'reader-affiliation-cards'
      for (const [title, roles] of [
        ['Current companies', (model.affiliations || []).filter(role => role.kind === 'employment' && role.current)],
        ['Schools', (model.affiliations || []).filter(role => role.kind === 'education')],
      ]) {
        const card = node('article')
        card.append(node('h3', title))
        const list = node('ul')
        for (const role of roles) {
          const organization = (model.connections || []).find(company => company.id === role.organizationId || company.name.toLowerCase() === role.organization.toLowerCase())
          const item = node('li')
          item.append(inlineEditor('affiliation-' + role.id, title === 'Schools' ? 'School' : 'Company', role.organization, 'text',
            organization => ({ action: 'affiliation', affiliationId: role.id, kind: role.kind, organization }),
            organizationIdentity(role.organization, role.role || role.degree, organization?.logoUrl || role.organizationLogoUrl, null, organization)))
          if (organization) {
            const open = button('Open', () => companyLink(organization.id))
            open.className = 'reader-affiliation-open'
            open.setAttribute('aria-label', 'Open ' + organization.name)
            item.append(open)
          }
          list.append(item)
        }
        if (roles.length) card.append(list)
        const kind = title === 'Schools' ? 'education' : 'employment'
        card.append(inlineEditor('add-' + kind, title === 'Schools' ? 'School' : 'Company', '', 'text',
          organization => ({ action: 'affiliation', kind, organization })))
        cards.append(card)
      }
      panel.append(cards)
    }

    const form = node('form')
    form.className = 'organization-details-form'
    const toggle = button(editing ? 'Done editing' : 'Edit details', () => {
      if (inlineActive) { inlineActive.querySelector('input,textarea')?.focus(); status.textContent = 'Save or cancel your field edit first.'; return }
      editing = form.hidden
      form.hidden = !editing
      toggle.textContent = editing ? 'Done editing' : 'Edit details'
      toggle.setAttribute('aria-expanded', String(editing))
      if (editing) form.querySelector('input')?.focus()
    })
    toggle.className = 'reader-edit-details'
    toggle.setAttribute('aria-expanded', String(editing))
    form.id = 'reader-details-form'
    toggle.setAttribute('aria-controls', form.id)
    form.hidden = !editing
    const revision = model.record.revision
    const inputs = new Map()
    form.addEventListener('input', () => { form.dataset.dirty = 'true' })
    for (const [key, label, kind] of person ? personFields : fields) {
      const evidence = model.evidence?.[key]
      const control = field(form, label, kind === 'type' ? 'select' : kind)
      if (kind === 'type') options(control, [['', 'Choose a type'], ['company','Company'], ['nonprofit','Nonprofit'], ['school','School'], ['university','University'], ['community','Community'], ['other','Other']])
      if (kind === 'number') { control.min = key === 'foundationYear' ? '1' : '0'; control.step = key === 'fundingRaised' ? 'any' : '1' }
      control.value = inputValue(model.record[key], kind)
      if (evidence) {
        const source = node('a', '✧ ' + evidence.provider)
        try {
          const url = new URL(evidence.url)
          if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
            source.href = url.href
            source.target = '_blank'
            source.rel = 'noopener noreferrer'
            source.className = 'reader-field-evidence'
            source.setAttribute('aria-label', label + ' enriched from ' + evidence.provider)
            control.parentElement.append(source)
          }
        } catch { /* A missing source link does not block editing. */ }
      }
      inputs.set(key, { control, baseline: control.value, kind })
    }
    if (!person) inputs.get('name').control.required = true
    const save = submit(form, 'Save details', () => {
      const patch = {}
      for (const [key, {control, baseline, kind}] of inputs) {
        if (control.value === baseline || kind === 'type' && !control.value) continue
        const text = control.value.trim()
        patch[key] = kind === 'list' ? text.split('\n').map(line => line.trim()).filter(Boolean) : kind === 'number' ? text ? Number(text) : null : text
      }
      if (Object.keys(patch).length) return run({ action: 'edit', revision, patch }, 'Details saved.', 'Details')
      status.textContent = 'Details are up to date.'
    })
    save.className = 'primary organization-save'
    form.prepend(save)
    const groupManager = node('details')
    groupManager.append(node('summary', 'Manage groups'))
    for (const member of model.memberships) {
      const group = model.groups.find(item => item.id === member.id)
      if (!group) continue
      const row = node('div')
      row.className = 'organization-row'
      row.append(node('span', group.name), button('Remove ' + group.name, () => void run({ action: 'group', groupId: group.id, remove: true }, 'Group removed.', 'Details')))
      addMeta(row, [displayDate(member.createdAt), pretty(member.createdBy)].filter(Boolean).join(' · '))
      groupManager.append(row)
    }
    if (model.groups.some(group => !model.memberships.some(member => member.id === group.id))) {
      const form = node('form'), select = field(form, 'Add to group', 'select')
      options(select, model.groups.filter(group => !model.memberships.some(member => member.id === group.id)).map(group => [group.id, group.name]))
      submit(form, 'Add group', () => run({ action: 'group', groupId: select.value }, 'Group added.', 'Details'))
      groupManager.append(form)
    }
    const latest = [model.interactions[0]?.title, model.notes[0]?.body, model.tasks.find(task => !task.completedAt)?.title].filter(Boolean)
    if (latest.length) {
      const recap = node('details')
      recap.append(node('summary', 'Recent activity'))
      for (const entry of latest) recap.append(node('p', entry))
      panel.append(recap)
    }
    const editor = node('div')
    editor.className = 'reader-details-editor'
    toolbar.querySelector('.reader-edit-details')?.remove()
    toolbar.append(toggle)
    editor.append(form)
    panel.append(editor)
    if (!editing) {
      const summary = node('dl')
      summary.className = 'reader-record-facts'
      for (const [key, label, kind] of person ? personFields : fields) {
        if (['name','fullName','firstName','lastName'].includes(key)) continue
        const value = inputValue(model.record[key], kind)
        if (!value && !['emails','phones'].includes(key)) continue
        const info = node('dd')
        if (kind === 'list') {
          const values = Array.isArray(model.record[key]) ? model.record[key] : []
          values.forEach((entry, index) => info.append(inlineEditor(key + '-' + index, label, pretty(entry),
            key === 'emails' ? 'email' : key === 'phones' ? 'tel' : 'text', text => ({ action: 'edit', patch: { [key]: values.flatMap((item, n) => n === index ? text ? [text] : [] : [item]) } }))))
          info.append(inlineEditor(key + '-add', label, '', key === 'emails' ? 'email' : key === 'phones' ? 'tel' : 'text',
            text => ({ action: 'edit', patch: { [key]: [...values, ...(text ? [text] : [])] } })))
        } else info.append(inlineEditor(key, label, value, kind, text => ({ action: 'edit', patch: { [key]: kind === 'number' ? text ? Number(text) : null : text } })))
        if (model.evidence?.[key]) {
          const marker = node('small', '✧ ' + model.evidence[key].provider)
          info.append(marker)
        }
        summary.append(node('dt', label), info)
      }
      if (summary.children.length) editor.append(summary)
      toggle.addEventListener('click', () => { summary.hidden = editing })
    }
    for (const custom of model.fields) {
      if (custom.type === 'person') continue
      const form = node('form')
      const kinds = { text: 'text', number: 'number', date: 'date', url: 'url', checkbox: 'checkbox', singleSelect: 'select', multiSelect: 'select' }
      const kind = kinds[custom.type]
      if (!kind) continue
      const control = field(form, custom.name, kind)
      if (kind === 'select') {
        control.multiple = custom.type === 'multiSelect'
        if (!control.multiple) options(control, [['', 'None']])
        options(control, (custom.options || []).map(option => [option.id, option.label]))
        if (control.multiple) for (const option of control.options) option.selected = Array.isArray(custom.value) && custom.value.includes(option.value)
        else control.value = custom.value || ''
      } else if (kind === 'checkbox') control.checked = custom.value === true
      else control.value = typeof custom.value === 'number' && kind === 'date' ? inputValue(custom.value, kind) : pretty(custom.value)
      submit(form, 'Save ' + custom.name, () => {
        const value = control.multiple ? [...control.selectedOptions].map(option => option.value) : kind === 'checkbox' ? control.checked :
          !control.value ? null : kind === 'number' ? Number(control.value) : kind === 'date' ? Date.parse(control.value) : control.value
        return run({ action: 'field', fieldId: custom.id, revision: custom.revision, value }, custom.name + ' saved.', 'Details')
      })
      panel.append(form)
    }
    if (model.groups.length) panel.append(groupManager)
    addMeta(panel, ['Created ' + displayDate(model.record.createdAt), pretty(model.record.createdBy)].filter(Boolean).join(' · '))
  }

  function renderPeople(panel) {
    for (const person of model.people) {
      const row = node('div')
      row.className = 'organization-row'
      row.append(button(person.name, () => personLink(person.id)))
      addMeta(row, person.jobTitle)
      panel.append(row)
    }
    if (!model.people.length) panel.append(node('p', 'No linked people yet.'))
    const form = node('form'), query = field(form, 'Find an existing contact', 'search'), results = node('div')
    query.minLength = 2
    query.required = true
    submit(form, 'Search', async () => {
      try {
        const { people } = await request({ action: 'find-people', query: query.value.trim() })
        const choices = people.filter(person => !model.people.some(linked => linked.id === person.id))
        results.replaceChildren(...(choices.length ? choices.map(person => button('Link ' + person.name, () => void run({ action: 'link-person', personId: person.id }, person.name + ' linked.', 'People'))) : [node('p', 'No unlinked contacts match.')]))
      } catch (error) { status.textContent = error.message }
    })
    panel.append(form, results)
  }

  function renderActivity(panel, title) {
    const notes = title === 'Notes', tasks = title === 'Tasks'
    if (title === 'Interactions') {
      renderReaderEvents(panel, { request, state: eventState, save: (payload, message) => run(payload, message, title) })
      const heading = node('h3', 'Interaction history')
      heading.className = 'reader-interaction-history'
      panel.append(heading)
    } else {
      const form = node('form')
      const subject = notes ? null : field(form, 'Task')
      if (subject) subject.required = true
      const body = field(form, notes ? 'New note' : 'Context (optional)', 'long')
      body.required = notes
      const date = tasks ? field(form, 'Due date', 'date') : null
      submit(form, notes ? 'Add note' : 'Add task', () => run({
        action: notes ? 'note' : 'task', title: subject?.value, body: body.value,
        date: date?.value ? new Date(date.value + 'T12:00:00').getTime() : null,
      }, notes ? 'Note added.' : 'Task added.', title))
      panel.append(form)
    }
    const rows = model[title.toLowerCase()]
    if (!rows.length) panel.append(node('p', 'No ' + title.toLowerCase() + ' yet.'))
    for (const row of rows) {
      const article = node('article')
      article.className = 'organization-row'
      if (row.title) article.append(node('strong', row.title))
      if (row.body) article.append(node('p', row.body))
      addMeta(article, [row.authorName || (row.completedAt ? 'Completed' : row.status === 'scheduled' ? 'Scheduled' : row.type), displayDate(row.createdAt || row.dueAt || row.startAt)].filter(Boolean).join(' · '))
      if (tasks) article.append(button(row.completedAt ? 'Reopen ' + row.title : 'Complete ' + row.title,
        () => void run({ action: 'complete-task', taskId: row.id, revision: row.revision }, row.completedAt ? 'Task reopened.' : 'Task completed.', title)))
      panel.append(article)
    }
  }

  function render(title) {
    const panel = panels.get(title)
    panel.replaceChildren()
    if (title === 'Details') renderDetails(panel)
    else if (title === 'People') renderPeople(panel)
    else if (title === 'Connections') {
      for (const organization of model.connections ?? []) {
        const row = node('div')
        row.className = 'organization-row'
        row.append(organizationIdentity(organization.name, organization.type, organization.logoUrl, () => companyLink(organization.id), organization))
        panel.append(row)
      }
      for (const role of model.affiliations ?? []) {
        if ((model.connections || []).some(company => company.name.toLowerCase() === role.organization.toLowerCase())) continue
        const row = node('div')
        row.className = 'organization-row'
        row.append(organizationIdentity(role.organization, [role.role || role.degree, role.startDate, role.endDate].filter(Boolean).join(' · '), role.organizationLogoUrl))
        panel.append(row)
      }
      if (!panel.children.length) panel.append(node('p', 'No affiliations saved.'))
    } else if (title === 'History') {
      for (const entry of model.history ?? []) {
        const row = node('div')
        row.className = 'organization-row'
        row.append(node('strong', entry.actor === 'reader-enrichment' ? 'Enriched fields' : entry.operation.replaceAll('_',' ')))
        addMeta(row, displayDate(entry.createdAt))
        panel.append(row)
      }
      if (!panel.children.length) panel.append(node('p', 'No changes recorded yet.'))
    } else renderActivity(panel, title)
  }

  select('Details')
  void run(undefined, '')
  return () => { live = false; toolbar.remove(); host.replaceChildren() }
}
