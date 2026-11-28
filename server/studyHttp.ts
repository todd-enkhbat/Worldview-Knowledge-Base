import { applicationContext } from './applicationContext.ts'
import {explainLocally} from './studyExplanation.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldDb } from './worldDb.ts'
import type { ChangeBus } from './changes.ts'
import { memoryOriginAllowed, readMemoryBody, sendMemoryJson } from './memoryHttp.ts'
import { applyStudy, decodeStudy, normalizeTerm, STUDY_KEY } from '../src/study/model.ts'
import { definition, installPack, packStatus } from './studyDictionary.ts'
export async function studyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  action: string,
  db: WorldDb,
  bus: ChangeBus,
  dir: string
) {
  if (!memoryOriginAllowed(req) || !req.headers['x-wv-client'])
    return sendMemoryJson(res, 403, { error: 'Open this workspace to use capture.' })
  const generation = db.getReplacementGeneration()
  try {
    if (req.method === 'GET' && action === 'state')
      return sendMemoryJson(res, 200, decodeStudy(db.getKv(STUDY_KEY)))
    if (req.method === 'GET' && action === 'packs') return sendMemoryJson(res, 200, packStatus(dir))
    if (req.method !== 'POST') return sendMemoryJson(res, 405, { error: 'Unsupported method.' })
    const v = await readMemoryBody(req,action==='application'?2*1024*1024:128*1024)
    if (generation !== db.getReplacementGeneration() || db.getKv('importInProgress') !== undefined)
      throw Error('The workspace changed. Reopen capture.')
    if(action==='application-context') {
      const result = await applicationContext(v, db)
      if (generation !== db.getReplacementGeneration()) throw Error('The workspace changed. Read this application again.')
      return sendMemoryJson(res,200,result)
    }
    if(action==='explain-local'){
      if(!['localhost','127.0.0.1','[::1]'].includes(new URL('http://'+req.headers.host).hostname))throw Error('Local explanations require the desktop workspace.')
      return sendMemoryJson(res,200,await explainLocally(String(v.text??''),String(v.book??'')))
    }
    if(action==='lookup'){
      const term=String(v.term??''),language=String(v.language??'en')
      const saved=decodeStudy(db.getKv(STUDY_KEY)).words.filter(w=>normalizeTerm(w.term)===normalizeTerm(term)).map(w=>({language:w.language,name:w.language,senses:w.senses,source:w.source}))
      if(saved.some(w=>w.language===language))return sendMemoryJson(res,200,saved)
      try{const rows=await definition(dir,term,language);return sendMemoryJson(res,200,rows.length?rows:saved)}
      catch(error){if(saved.length)return sendMemoryJson(res,200,saved);throw error}
    }
    if (action === 'install') {
      installPack(dir, String(v.language))
      return sendMemoryJson(res, 202, { started: true })
    }
    if(action==='application' && v.workspaceToken && v.workspaceToken!==db.crm.workspaceFingerprint())throw Error('The workspace changed. Read this application again.')
    const state = decodeStudy(db.getKv(STUDY_KEY)),
      revision = state.revision
    const id = applyStudy(state, action, v)
    state.revision++
    if (!db.compareAndSwapKv(STUDY_KEY, state, revision))
      return sendMemoryJson(res, 409, { error: 'The archive changed. Retry your edit.' })
    bus.publish({ v: 1, from: 'study-helper', change: { type: 'kv', keys: [STUDY_KEY] } })
    return sendMemoryJson(res, 200, { id, ...(action==='application' ? {workspaceToken:db.crm.workspaceFingerprint()} : {}) })
  } catch (e) {
    return sendMemoryJson(res, 400, { error: e instanceof Error ? e.message : 'Capture failed.' })
  }
}
