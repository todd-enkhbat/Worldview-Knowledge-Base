import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SqliteCrmStore } from './crmStore.ts'
import { calendarInteraction, confirmedAttendees } from '../src/crm/calendarDate.ts'
import { crmEmail, crmHash } from './crmConnectionParsers.ts'
import type { RelationshipHistory, RelationshipTouch, ReconnectQueue } from '../src/crm/connectionTypes.ts'

interface MailEvidence {
  id: string
  messageId: string
  at: number
  subject: string
  owner: string
  from: string[]
  recipients: string[]
}
interface Mailbox { id: string; label: string; email?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Ignore display names and comments: they can contain somebody else's address. */
function headerAddresses(value: string): string[] {
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ')
  if (/[\r\n]/.test(unfolded)) return []
  const mailboxes = unfolded.replace(/"(?:\\.|[^"\\])*"|\([^()]*\)/g, '').split(',')
  return mailboxes.flatMap(mailbox => {
    const bracketed = mailbox.match(/^[^<>]*<([^<>]+)>\s*$/)
    const address = crmEmail(bracketed ? bracketed[1] : mailbox.trim())
    return address ? [address] : []
  })
}

function parseMessages(records: unknown): MailEvidence[] {
  if (!Array.isArray(records)) throw new Error('Invalid retained header batch.')
  const messages: MailEvidence[] = []
  for (const row of records) {
    if (!object(row) || typeof row.id !== 'string' || !Array.isArray(row.headers)) continue
    if (Array.isArray(row.labelIds) && row.labelIds.some(label => ['DRAFT', 'SPAM', 'TRASH'].includes(String(label)))) continue
    const headers = row.headers.filter(object)
    const values = (name: string) => headers.filter(h => typeof h.name === 'string' && h.name.toLowerCase() === name && typeof h.value === 'string').map(h => String(h.value))
    if (values('list-id').length || values('auto-submitted').some(value => value.trim().toLowerCase() !== 'no') || values('precedence').some(value => /^(bulk|list|junk)$/i.test(value.trim()))) continue
    const addresses = (name: string) => values(name).flatMap(headerAddresses)
    const at = Number(row.internalDate) || Date.parse(values('date')[0] || '')
    if (!Number.isSafeInteger(at) || at <= 0) continue
    messages.push({ id: row.id, messageId: values('message-id')[0]?.trim() || '', at, subject: values('subject')[0]?.trim() || '', from: addresses('from'), recipients: [...addresses('to'), ...addresses('cc')], owner: crmEmail(row.accountEmail) })
  }
  return messages
}

/** A derived view. Resolve addresses on each read so merges and later captures also match old mail. */
export class CrmRelationshipHistory {
  private cache = new Map<string, MailEvidence[]>()
  private blobDir: string
  constructor(blobDir: string) { this.blobDir = blobDir }
  private async batch(id: string) {
    if (!/^crm-file-[a-f0-9]{64}$/.test(id)) throw new Error('Invalid header source.')
    const cached = this.cache.get(id)
    if (cached) return cached
    const file = await open(join(this.blobDir, id), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid retained headers.')
      const bytes = await file.readFile()
      if ('crm-file-' + crmHash(bytes) !== id) throw new Error('Changed header source.')
      const parsed = parseMessages(JSON.parse(bytes.toString()))
      if (this.cache.size >= 2048) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(id, parsed)
      return parsed
    } finally { await file.close() }
  }

  private contactIndex(store: SqliteCrmStore, accounts: Mailbox[]) {
    const people = store.rows('people')
    const contacts = new Map(people.filter(person => person.archivedAt === null && !person.mergedIntoId).map(person => [person.id, person]))
    const canonical = new Map([...contacts.keys()].map(id => [id, id]))
    for (const merged of people.filter(person => person.mergedIntoId)) {
      const active = store.resolvePerson(merged.id)
      if (active && contacts.has(active.id)) canonical.set(merged.id, active.id)
    }
    const addresses = new Map<string, string | null>()
    for (const person of contacts.values()) for (const address of new Set(person.emails.map(crmEmail).filter(Boolean))) {
      addresses.set(address, addresses.has(address) ? null : person.id)
    }
    const shared = new Set([...addresses].filter(([, id]) => !id).map(([email]) => email))
    for (const account of accounts) addresses.delete(crmEmail(account.email))
    return { contacts, canonical, addresses, shared }
  }

  private async visit(store: SqliteCrmStore, accounts: Mailbox[], index: ReturnType<CrmRelationshipHistory['contactIndex']>, selected: Set<string>, now: number, current: () => void, add: (id: string, touch: RelationshipTouch) => void) {
    const mailboxes = new Map(accounts.map(account => [account.id, account]))
    const visited = new Set<string>()
    let unavailableSources = 0
    const addresses = new Map([...index.addresses].filter(([, id]) => id && selected.has(id)))
    if (addresses.size) for (const receipt of store.rows('imports', false)) {
      if (receipt.provider !== 'gmail-headers') continue
      const account = mailboxes.get(receipt.accountId)
      for (const source of receipt.originalAssetIds) {
        const sourceKey = JSON.stringify([receipt.accountId, source])
        if (visited.has(sourceKey)) continue
        visited.add(sourceKey)
        let rows: MailEvidence[]
        current()
        try { rows = await this.batch(source) } catch { unavailableSources++; continue }
        current()
        for (const row of rows) {
          const owner = row.owner || crmEmail(account?.email)
          if (!owner || row.at > now) continue
          const sent = row.from.includes(owner)
          if (!sent && !row.recipients.includes(owner)) continue
          const correspondents = sent ? row.recipients : row.from
          for (const address of correspondents) {
            const personId = addresses.get(address)
            if (!personId || address === owner) continue
            const id = row.messageId ? JSON.stringify([row.messageId, row.from]) : JSON.stringify([receipt.accountId, row.id])
            add(personId, { id, at: row.at, title: row.subject || 'Email', channel: 'Email', source: account?.label || owner, direction: sent ? 'sent' : 'received', url: 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(owner) + '#all/' + encodeURIComponent(row.id) })
          }
        }
      }
    }
    for (const row of store.rows('interactions', false)) {
      const at = row.occurredAt ?? row.startAt
      if (row.status !== 'logged' || at === null || at > now) continue
      const source = row.sourceRefs[0]
      const raw = object(row.raw) ? row.raw : {}
      const identity = typeof raw.iCalUID === 'string' && calendarInteraction(row)
        ? JSON.stringify(['calendar', raw.iCalUID, raw.originalStartTime ?? row.startAt])
        : source ? JSON.stringify([source.provider, source.accountId, source.externalId]) : row.id
      for (const id of calendarInteraction(row) ? confirmedAttendees(row) : row.personIds) {
        const personId = index.canonical.get(id)
        if (personId && selected.has(personId)) add(personId, { id: 'logged:' + identity, at, title: row.title || row.type, channel: row.type, source: row.sourceRefs[0]?.provider || 'Manually logged', direction: 'logged' })
      }
    }
    current()
    return unavailableSources
  }

  async reconnect(store: SqliteCrmStore, accounts: Mailbox[], now: number, offset: number, current: () => void): Promise<ReconnectQueue> {
    const index = this.contactIndex(store, accounts), eligible = new Set(index.contacts.keys())
    for (const task of store.rows('tasks', false)) {
      if (task.completedAt !== null) continue
      for (const ref of task.entityRefs) if (ref.type === 'person') eligible.delete(index.canonical.get(ref.id) ?? ref.id)
    }
    const latest = new Map<string, RelationshipTouch>()
    const unavailableSources = await this.visit(store, accounts, index, eligible, now, current, (personId, event) => {
      if (event.at > (latest.get(personId)?.at ?? -Infinity)) latest.set(personId, event)
    })
    const rows = [...latest].filter(([, touch]) => touch.at <= now - 30 * 86400000).sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))
    return { total: rows.length, unavailableSources, rows: rows.slice(offset, offset + 10).map(([id, last]) => {
      const person = index.contacts.get(id)!
      return { id, name: person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.emails[0] || 'Contact', idleDays: Math.floor((now - last.at) / 86400000), last }
    }) }
  }

  async read(store: SqliteCrmStore, personId: string, accounts: Mailbox[], now: number, offset: number, current: () => void): Promise<RelationshipHistory> {
    const index = this.contactIndex(store, accounts)
    const person = index.contacts.get(index.canonical.get(personId) ?? '')
    if (!person) throw new Error('Contact unavailable.')
    const events = new Map<string, RelationshipTouch>()
    const unavailableSources = await this.visit(store, accounts, index, new Set([person.id]), now, current, (_id, event) => {
      const previous = events.get(event.id)
      if (!previous || previous.title === 'Email' && event.title !== 'Email') events.set(event.id, event)
    })
    const aliases = new Set([...index.canonical].filter(([, id]) => id === person.id).map(([alias]) => alias))
    const introductions = new Map<string, RelationshipHistory['introductions'][number]>()
    for (const edge of store.rows('relationships', false)) {
      if (!edge.confirmed || edge.from.type !== 'person' || edge.to.type !== 'person') continue
      const relation = edge.relation.trim().toLowerCase()
      const id = relation === 'introduced by' && aliases.has(edge.from.id) ? edge.to.id :
        relation === 'introduced' && aliases.has(edge.to.id) ? edge.from.id : ''
      if (!id || aliases.has(id)) continue
      const who = store.resolvePerson(id)
      if (!who || who.archivedAt !== null) continue
      introductions.set(who.id, { personId: who.id, name: who.fullName || [who.firstName, who.lastName].filter(Boolean).join(' ') || who.emails[0] || 'Contact', source: edge.evidence[0]?.label || edge.sourceRefs[0]?.provider || 'Saved relationship' })
    }
    current()
    const history = [...events.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    return { total: history.length, introductions: [...introductions.values()], recentCount: history.filter(event => event.at >= now - 90 * 86400000).length, first: history.at(-1) ?? null, last: history[0] ?? null, sent: history.filter(e => e.direction === 'sent').length, received: history.filter(e => e.direction === 'received').length, ambiguousEmails: new Set(person.emails.map(crmEmail).filter(email => index.shared.has(email))).size, unavailableSources, offset, timeline: history.slice(offset, offset + 25) }
  }
}
