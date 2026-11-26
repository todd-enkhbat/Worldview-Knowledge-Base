import {docTarget,extractApplicationTab} from './connections/applicationDoc.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GoogleDriveConnection } from './connections/googleDrive.ts'
import type { WorldDb } from './worldDb.ts'
import { memoryOriginAllowed, readMemoryBody, sendMemoryJson } from './memoryHttp.ts'
import { htmlToText } from './fetchUrl.ts'

type Service = 'drive' | 'gmail'
interface Session {
  service: Service
  redirect: string
  origin: string
  verifier: string
  expires: number
  generation: number
}
interface Account {
  id: string
  service: Service
  label: string
  access: string
  expires: number
  generation: number
  candidates: Map<string, Candidate>
}
interface Candidate {
  id: string
  title: string
  mime: string
  date: string
}
const scope = (s: Service) => 'https://www.googleapis.com/auth/' + s + '.readonly'
const api = 'https://www.googleapis.com'
const mail = 'https://gmail.googleapis.com/gmail/v1/users/me'
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const clean = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : '')
const escapeDrive = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
async function remote(url: string, token: string) {
  const r = await fetch(url, {
    headers: { authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(16000)
  })
  if (!r.ok) throw Error('Google could not read this item. Reconnect or check your search scope.')
  return r
}
interface MailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: MailPart[]
  headers?: { name: string; value: string }[]
}
function mailText(p: MailPart, plain: boolean): string {
  if (p.mimeType === (plain ? 'text/plain' : 'text/html') && p.body?.data) {
    const value = Buffer.from(p.body.data, 'base64url').toString('utf8')
    return plain ? value : htmlToText(value)
  }
  return (p.parts ?? [])
    .map((n) => mailText(n, plain))
    .filter(Boolean)
    .join('\n')
}

export class ApplicationDiscovery {
  // Read-only authorization lasts one reading session. Tokens never enter backups.
  sessions = new Map<string, Session>()
  accounts = new Map<string, Account>()
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    action: string,
    drive: GoogleDriveConnection,
    db: WorldDb
  ) {
    try {
      const origin = 'http://' + req.headers.host,
        url = new URL(req.url!, origin)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
        throw Error('Use the local Worldview workspace.')
      const generation = db.getReplacementGeneration()
      for (const map of [this.sessions, this.accounts])
        for (const [key, v] of map) if (v.expires <= Date.now() || v.generation !== generation) map.delete(key)
      if (action === 'callback' && req.method === 'GET') {
        const key = url.searchParams.get('state') ?? '',
          s = this.sessions.get(key)
        this.sessions.delete(key)
        if (!s || new URL(s.redirect).origin !== origin || !url.searchParams.get('code'))
          throw Error('Connection expired or declined.')
        const client = await drive.discoveryClient()
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(16000),
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.id,
            ...(client.secret ? { client_secret: client.secret } : {}),
            code: url.searchParams.get('code')!,
            redirect_uri: s.redirect,
            code_verifier: s.verifier
          })
        })
        const token = await r.json()
        if (!r.ok || typeof token.access_token !== 'string' || token.scope !== scope(s.service))
          throw Error('Google did not issue the requested read-only permission.')
        const profile = await (
          await remote(
            s.service === 'drive' ? api + '/drive/v3/about?fields=user(emailAddress)' : mail + '/profile',
            token.access_token
          )
        ).json()
        if (db.getReplacementGeneration() !== generation) throw Error('The workspace changed. Connect again.')
        const id = randomUUID()
        this.accounts.set(id, {
          id,
          access: token.access_token,
          label: profile.user?.emailAddress ?? profile.emailAddress ?? 'Google account',
          service: s.service,
          candidates: new Map(),
          expires: Date.now() + Math.min(3600, Number(token.expires_in) || 3600) * 1000,
          generation
        })
        res
          .writeHead(303, {
            location: s.origin + '/#/applications',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer'
          })
          .end()
        return
      }
      if (!memoryOriginAllowed(req) || !req.headers['x-wv-client'])
        throw Error('Open Applications in the local workspace.')
      if (req.method === 'GET' && action === 'accounts')
        return sendMemoryJson(
          res,
          200,
          [...this.accounts.values()].map(({ id, label, service }) => ({ id, label, service }))
        )
      if (req.method !== 'POST') throw Error('Unsupported discovery request.')
      const v = await readMemoryBody(req)
      if(action==='document') {
        const target=docTarget(clean(v.url)), account=this.accounts.get(clean(v.account))
        if(!account) return sendMemoryJson(res,200,await drive.applicationTab(target.source,clean(v.email)))
        if(account.service!=='drive'||v.email&&clean(v.email).toLowerCase()!==account.label.toLowerCase())throw Error('Choose the Drive connection for this document.')
        const result=await remote('https://docs.googleapis.com/v1/documents/'+target.id+'?includeTabsContent=true',account.access)
        const doc=extractApplicationTab(await result.json(),target.tab)
        return sendMemoryJson(res,200,{...doc,source:target.source,confirmation:false,date:''})
      }
      if (action === 'connect') {
        const service = v.service
        if (service !== 'drive' && service !== 'gmail') throw Error('Choose a Google service.')
        const client = await drive.discoveryClient(),
          base = new URL(origin)
        if (client.desktop && base.hostname === 'localhost') base.hostname = '127.0.0.1'
        const redirect = base.origin + '/api/study-google/callback'
        if (!client.desktop && !client.redirects.includes(redirect))
          throw Error('Add ' + redirect + ' to your Google OAuth redirect addresses.')
        const verifier = randomBytes(48).toString('base64url'),
          key = randomBytes(32).toString('base64url')
        this.sessions.set(key, { service, verifier, origin, redirect, generation, expires: Date.now() + 600000 })
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: client.id,
          redirect_uri: redirect,
          state: key,
          scope: scope(service),
          prompt: 'select_account consent',
          include_granted_scopes: 'false',
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url')
        })
        return sendMemoryJson(res, 200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params })
      }
      const a = this.accounts.get(clean(v.account))
      if (!a) throw Error('Connect the account for this search.')
      if (action === 'disconnect') {
        this.accounts.delete(a.id)
        return sendMemoryJson(res, 200, { ok: true })
      }
      if (action === 'search') {
        const terms = clean(v.terms),
          folder = clean(v.folder),
          from = clean(v.from),
          to = clean(v.to)
        if (!terms && !folder && !from && !to) throw Error('Choose a folder, label, date, or search phrase.')
        if ((from && !datePattern.test(from)) || (to && !datePattern.test(to)) || (to && from > to))
          throw Error('Choose a valid date range.')
        let candidates: Candidate[]
        if (a.service === 'drive') {
          const q = [
            'trashed = false',
            "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain' or mimeType = 'text/markdown')"
          ]
          if (terms) q.push("fullText contains '" + escapeDrive(terms) + "'")
          if (folder) q.push("'" + escapeDrive(folder) + "' in parents")
          if (from) q.push("modifiedTime >= '" + from + "T00:00:00Z'")
          if (to) q.push("modifiedTime <= '" + to + "T23:59:59Z'")
          const data = await (
            await remote(
              api +
                '/drive/v3/files?' +
                new URLSearchParams({
                  q: q.join(' and '),
                  fields: 'files(id,name,mimeType,modifiedTime)',
                  orderBy: 'modifiedTime desc',
                  pageSize: '25'
                }),
              a.access
            )
          ).json()
          candidates = (data.files ?? []).map(
            (f: { id: string; name: string; mimeType: string; modifiedTime: string }) => ({
              id: f.id,
              title: f.name,
              mime: f.mimeType,
              date: f.modifiedTime
            })
          )
        } else {
          const q = [
            terms,
            folder && 'label:"' + folder.replace(/"/g, '') + '"',
            from && 'after:' + from.replaceAll('-', '/'),
            to && 'before:' + new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10).replaceAll('-', '/')
          ]
            .filter(Boolean)
            .join(' ')
          const data = await (
            await remote(mail + '/messages?' + new URLSearchParams({ q, maxResults: '15' }), a.access)
          ).json()
          candidates = await Promise.all(
            (data.messages ?? []).map(async ({ id }: { id: string }) => {
              const item = await (
                await remote(
                  mail + '/messages/' + encodeURIComponent(id) + '?format=metadata&metadataHeaders=Subject',
                  a.access
                )
              ).json()
              return {
                id,
                title:
                  item.payload?.headers?.find((h: { name: string }) => h.name.toLowerCase() === 'subject')
                    ?.value ?? 'Message',
                mime: 'message/rfc822',
                date: new Date(Number(item.internalDate)).toISOString()
              }
            })
          )
        }
        a.candidates = new Map(candidates.map((c) => [c.id, c]))
        return sendMemoryJson(res, 200, candidates)
      }
      const item = a.candidates.get(clean(v.id))
      if (action !== 'preview' || !item) throw Error('Choose an item from this search.')
      const id = encodeURIComponent(item.id)
      let text: string, source: string
      if (a.service === 'gmail') {
        const data = await (await remote(mail + '/messages/' + id + '?format=full', a.access)).json()
        text = mailText(data.payload, true) || mailText(data.payload, false)
        source = 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(a.label) + '#all/' + id
      } else {
        text = await (
          await remote(
            api +
              '/drive/v3/files/' +
              id +
              (item.mime.includes('google-apps') ? '/export?mimeType=text%2Fplain' : '?alt=media'),
            a.access
          )
        ).text()
        source = 'https://drive.google.com/open?id=' + id
      }
      const confirmation =
        a.service === 'gmail' &&
        /application (?:was |has been )?(?:received|submitted)|thank you for (?:your application|applying)/i.test(
          item.title + ' ' + text
        )
      return sendMemoryJson(res, 200, {
        text: text.slice(0, 100000),
        source,
        title: item.title,
        confirmation,
        date: item.date
      })
    } catch (e) {
      return sendMemoryJson(res, 400, { error: e instanceof Error ? e.message : 'Discovery failed.' })
    }
  }
}
