import { universityCandidate } from './universityArtwork.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { CrmAffiliation, CrmCompany } from '../src/crm/types.ts'
import type { WorldDb } from './worldDb.ts'
import { CrmError } from './crmStore.ts'
import { completeCompanyProfile, OrganizationEnrichmentQueue, populateCompany, type OrganizationServices } from './crmLinkedOrganizations.ts'

const RUN = 'organization-enrichment:latest'
const LEASE_MS = 90_000
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
interface Progress {
  state: 'idle' | 'running' | 'complete'
  runId: string | null
  total: number
  processed: number
  remaining: number
  updated: number
  unchanged: number
  unresolved: number
  completeRecords: number
  partial: number
  failed: number
}
interface Work { company_id: string; job_id: string }
const empty: Progress = { state: 'idle', runId: null, total: 0, processed: 0, remaining: 0, updated: 0, unchanged: 0, unresolved: 0, completeRecords: 0, partial: 0, failed: 0 }

/** Checkpoints live in the same SQLite database as the companies. A process
 * can reclaim an abandoned lease and replay the same source/field receipts. */
export class CompanyEnrichmentJobs {
  private readonly owner = randomUUID()
  private readonly guards = new Map<string, () => void>()
  private readonly captureGuards = new Map<string, () => void>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private holds = 0
  private readonly world: WorldDb
  private readonly services: OrganizationServices
  private readonly queue: OrganizationEnrichmentQueue
  private readonly now: () => number
  constructor(world: WorldDb, services: OrganizationServices, queue: OrganizationEnrichmentQueue, now: () => number = Date.now) {
    this.world = world; this.services = services; this.queue = queue; this.now = now
    this.services.store.setCompanyEnrichmentHook((id, requestId) => this.enqueue(id, requestId))
    if (this.available()) this.queueExistingUniversities()
    this.wake()
  }
  private queueExistingUniversities() {
    const marker='university-artwork:v1'
    if(this.world.db.prepare('SELECT 1 FROM crm_state WHERE key=?').get(marker)) return
    this.world.tx(()=>{
      this.world.db.prepare('INSERT OR IGNORE INTO crm_state VALUES(?,?)').run(marker,'true')
      for(const company of this.services.store.rows('companies',false)) {
        if(!company.logoAssetId && universityCandidate(company)) this.enqueue(company.id,marker)
      }
    })
  }
  private available() {
    return !this.closed && this.world.db.isOpen && !this.world.getKv('importInProgress') && this.world.getSettings()?.firstRunComplete
  }
  private head(): Progress {
    const row = this.world.db.prepare('SELECT body FROM crm_state WHERE key=?').get(RUN)
    return row ? JSON.parse(String(row.body)) as Progress : empty
  }
  status(): Progress {
    const head = this.head()
    if (head.state !== 'running' || !head.runId) return head
    const rows = this.world.db.prepare('SELECT state,complete,failed,COUNT(*) n FROM crm_organization_work WHERE run_id=? GROUP BY state,complete,failed').all(head.runId)
    const progress: Progress = { ...empty, state: 'running', runId: head.runId }
    for (const row of rows) {
      const n = Number(row.n), state = String(row.state)
      progress.total += n
      if (state === 'pending') { progress.remaining += n; continue }
      progress.processed += n
      if (state === 'updated' || state === 'unchanged' || state === 'unresolved') progress[state] += n
      if (row.complete === 1) progress.completeRecords += n
      if (row.complete === 0) progress.partial += n
      if (row.failed === 1) progress.failed += n
    }
    if (!progress.remaining) {
      progress.state = 'complete'
      const saved = this.world.db.prepare("UPDATE crm_state SET body=? WHERE key=? AND json_extract(body,'$.runId')=?").run(JSON.stringify(progress), RUN, head.runId)
      if (!saved.changes) return this.head()
    }
    return progress
  }
  start(requestId: unknown) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 150) throw new CrmError('Provide a unique organization enrichment request identity.')
    if (!this.available()) throw new CrmError('Finish workspace setup or restore before enriching companies.', 409)
    const receiptKey = 'organization-enrichment:request:' + digest(requestId)
    if (this.status().state !== 'running' && !this.world.db.prepare('SELECT 1 FROM crm_state WHERE key=?').get(receiptKey)) {
      this.services.store.command({ operation: 'sync_affiliation_groups', requestId: 'org-groups:' + requestId })
    }
    const result = this.world.tx(() => {
      const previous = this.status()
      if (this.world.db.prepare('SELECT 1 FROM crm_state WHERE key=?').get(receiptKey)) return previous
      const runId = previous.state === 'running' ? previous.runId! : randomUUID()
      this.world.db.prepare('INSERT INTO crm_state VALUES(?,?)').run(receiptKey, JSON.stringify({ runId }))
      if (previous.state === 'running') return previous
      const head = { ...empty, state: 'running', runId }
      this.world.db.prepare('INSERT OR REPLACE INTO crm_state VALUES(?,?)').run(RUN, JSON.stringify(head))
      // Snapshot active IDs in one statement. Edits during a scan cannot shift a
      // page offset or silently drop a company from the frozen total.
      this.world.db.prepare(`INSERT INTO crm_organization_work(company_id,job_id,run_id,state,priority)
        SELECT id,lower(hex(randomblob(16))),?,'pending',CASE WHEN json_extract(body,'$.domain') != '' THEN 0 ELSE 1 END
        FROM crm_rows WHERE collection='companies' AND archived=0
        ON CONFLICT(company_id) DO UPDATE SET job_id=excluded.job_id,run_id=excluded.run_id,state='pending',priority=excluded.priority,complete=0,failed=0,lease=NULL,expires_at=0`).run(runId)
      return this.status()
    })
    this.wake()
    return result
  }
  /** Called inside the creating transaction as well as after direct profile recapture. */
  enqueue(id: string, requestId: string, authorize?: () => void) {
    if (this.closed || !this.world.db.isOpen) return
    const company = this.services.store.get('companies', id)
    if (!company || company.archivedAt !== null || completeCompanyProfile(company)) return
    const sourceRequest = requestId.replace(/^profile-apply:/, ''), job = digest(JSON.stringify([id, sourceRequest]))
    const guard = authorize ?? this.captureGuards.get(sourceRequest)
    this.world.db.prepare(`INSERT INTO crm_organization_work(company_id,job_id,state,priority) VALUES(?,?,'pending',?)
      ON CONFLICT(company_id) DO UPDATE SET job_id=excluded.job_id,run_id=NULL,state='pending',priority=excluded.priority,complete=0,failed=0,lease=NULL,expires_at=0
      WHERE crm_organization_work.job_id != excluded.job_id AND crm_organization_work.state != 'pending'
      AND NOT EXISTS(SELECT 1 FROM crm_state WHERE key=? AND json_extract(body,'$.state')='running' AND json_extract(body,'$.runId')=crm_organization_work.run_id)`).run(id, job, company.domain ? 0 : 1, RUN)
    if (guard && this.world.db.prepare("SELECT 1 FROM crm_organization_work WHERE company_id=? AND job_id=? AND state='pending'").get(id, job)) {
      this.guards.set(job, guard)
      const reader = sourceRequest.match(/^reader-add:([a-f0-9-]{36}):\d+$/i)?.[1]
      if (reader) this.world.db.prepare('INSERT OR REPLACE INTO crm_state VALUES(?,?)').run('org-reader:' + job, JSON.stringify(reader))
    }
    this.wake()
  }
  /** Give the direct capture's selected logo priority over a background source. */
  async duringCapture<T>(requestId: string, authorize: (() => void) | undefined, save: () => Promise<T>): Promise<T> {
    this.holds++
    if (authorize) this.captureGuards.set(requestId, authorize)
    try { return await save() }
    finally { this.captureGuards.delete(requestId); this.holds--; this.wake() }
  }
  wake() {
    if (!this.available() || this.holds || !this.world.db.prepare("SELECT 1 FROM crm_organization_work WHERE state='pending' LIMIT 1").get()) return
    this.queue.enqueue('worldview:company-enrichment-jobs', () => this.batch())
  }
  private async batch() {
    if (!this.available() || this.holds) return
    const now = Date.now(), generation = this.world.getReplacementGeneration()
    const jobs = this.world.tx(() => {
      const selected = this.world.db.prepare("SELECT company_id,job_id FROM crm_organization_work WHERE state='pending' AND expires_at<=? ORDER BY priority,rowid LIMIT 3").all(now) as unknown as Work[]
      const claim = this.world.db.prepare('UPDATE crm_organization_work SET lease=?,expires_at=? WHERE company_id=? AND job_id=?')
      for (const work of selected) claim.run(this.owner, now + LEASE_MS, work.company_id, work.job_id)
      return selected
    })
    if (!jobs.length) {
      const row = this.world.db.prepare("SELECT MIN(expires_at) earliest FROM crm_organization_work WHERE state='pending'").get()
      if (row?.earliest) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.wake(), Math.max(50, Math.min(LEASE_MS, Number(row.earliest) - now + 5)))
        this.timer.unref()
      }
      return
    }
    await Promise.all(jobs.map(work => this.perform(work, generation)))
    if (this.available() && generation === this.world.getReplacementGeneration()) { this.status(); this.wake() }
  }
  private async perform(work: Work, generation: number) {
    const { store } = this.services, id = work.company_id
    const owns = () => this.available() && generation === this.world.getReplacementGeneration() &&
      !!this.world.db.prepare("SELECT 1 FROM crm_organization_work WHERE company_id=? AND job_id=? AND lease=? AND state='pending'").get(id, work.job_id, this.owner)
    const company = store.get('companies', id)
    const reader = this.world.db.prepare('SELECT body FROM crm_state WHERE key=?').get('org-reader:' + work.job_id)
    const readerId = reader && JSON.parse(String(reader.body)) as string
    let state = 'unresolved', complete = -1, failed = 0, renewed = Date.now()
    const current = () => {
      if (!owns()) throw new CrmError('The workspace or enrichment job changed.', 409)
      this.guards.get(work.job_id)?.()
      if (readerId && !this.world.getKv<{ clients: { id: string; revokedAt: number | null; expiresAt: number }[] }>('reading.capture.clients.v1')?.clients.some(client => client.id === readerId && !client.revokedAt && client.expiresAt > this.now())) throw new CrmError('The initiating Reader pairing is unavailable.', 403)
      const saved = store.get('companies', id)
      if (!saved || saved.archivedAt !== null || saved.name !== company?.name) throw new CrmError('The company changed during enrichment.', 409)
      if (Date.now() - renewed > LEASE_MS / 3) {
        renewed = Date.now()
        this.world.db.prepare('UPDATE crm_organization_work SET expires_at=? WHERE company_id=? AND lease=?').run(renewed + LEASE_MS, id, this.owner)
      }
    }
    try {
      current()
      complete = 0
      const result = await populateCompany(this.services, company!, work.job_id, current, this.logoRole(company!))
      current()
      state = result.status; complete = Number(result.complete); failed = Number(result.failed)
    } catch { /* A removed company, revoked authorization or superseding job cannot receive new fields. */ }
    if (!owns()) { this.guards.delete(work.job_id); return }
    this.world.db.prepare('UPDATE crm_organization_work SET state=?,complete=?,failed=?,lease=NULL,expires_at=0 WHERE company_id=? AND job_id=? AND lease=?')
      .run(state, complete, failed, id, work.job_id, this.owner)
    this.guards.delete(work.job_id)
    if (readerId) this.world.db.prepare('DELETE FROM crm_state WHERE key=?').run('org-reader:' + work.job_id)
  }
  private logoRole(company: CrmCompany) {
    if (company.logoAssetId || !company.logoUrl) return
    const role = this.world.db.prepare(`SELECT a.value FROM crm_rows p, json_each(p.body,'$.affiliations') a
      WHERE p.collection='people' AND p.archived=0 AND json_extract(a.value,'$.organizationId')=? AND json_extract(a.value,'$.organizationLogoUrl')=?
      AND EXISTS(SELECT 1 FROM json_each(a.value,'$.evidence') e WHERE json_extract(e.value,'$.sourceRef.provider')='profile-capture') LIMIT 1`).get(company.id, company.logoUrl)
    return role ? JSON.parse(String(role.value)) as CrmAffiliation : undefined
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.guards.clear()
    this.services.store.setCompanyEnrichmentHook()
    if (this.world.db.isOpen) this.world.db.prepare('UPDATE crm_organization_work SET lease=NULL,expires_at=0 WHERE lease=?').run(this.owner)
  }
}
