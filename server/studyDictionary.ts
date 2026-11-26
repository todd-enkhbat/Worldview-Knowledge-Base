import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { htmlToText } from './fetchUrl.ts'
import { normalizeTerm, type Sense } from '../src/study/model.ts'

export const languages: Record<string, string> = {
  en: 'English',
  it: 'Italian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  la: 'Latin',
  el: 'Greek',
  grc: 'Ancient Greek',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ru: 'Russian',
  ar: 'Arabic'
}
const jobs = new Map<string, { count: number; error?: string; running: boolean }>()
function open(dir: string) {
  const db = new DatabaseSync(join(dir, 'dictionary.sqlite'))
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS senses(lang TEXT,term TEXT,definition TEXT,PRIMARY KEY(lang,term)); CREATE TABLE IF NOT EXISTS packs(lang TEXT PRIMARY KEY,installed INTEGER)'
  )
  return db
}
export function packStatus(dir: string) {
  const db = open(dir)
  try {
    return Object.entries(languages).map(([code, name]) => ({
      code,
      name,
      installed: !!db.prepare('SELECT installed FROM packs WHERE lang=?').get(code),
      ...jobs.get(dir + code)
    }))
  } finally {
    db.close()
  }
}
export function installPack(dir: string, code: string) {
  if (!Object.hasOwn(languages, code)) throw Error('Choose a supported language.')
  if (jobs.get(dir + code)?.running) return
  const job = { running: true, count: 0, error: '' }
  jobs.set(dir + code, job)
  void (async () => {
    const name = languages[code],
      url =
        'https://kaikki.org/dictionary/' +
        encodeURIComponent(name) +
        '/kaikki.org-dictionary-' +
        encodeURIComponent(name) +
        '.jsonl'
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(25 * 60000) })
    if (!res.ok || !res.body) throw Error('The dictionary download is unavailable.')
    const db = open(dir)
    try {
      db.exec('CREATE TEMP TABLE staged(term TEXT,definition TEXT)')
      const insert = db.prepare('INSERT INTO staged VALUES(?,?)')
      for await (const line of createInterface({
        input: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        crlfDelay: Infinity
      })) {
        const r = JSON.parse(line)
        if (r.lang_code !== code || typeof r.word !== 'string' || !Array.isArray(r.senses)) continue
        const senses = Array.from(r.senses as { glosses?: string[] }[]).flatMap((s) =>
          (s.glosses ?? [])
            .filter((x) => typeof x === 'string' && x)
            .slice(0, 4)
            .map((meaning) => ({ pos: String(r.pos ?? ''), meaning: meaning.slice(0, 5000) }))
        )
        if (senses.length) {
          insert.run(normalizeTerm(r.word), JSON.stringify(senses.slice(0, 80)))
          job.count++
        }
      }
      if (!job.count) throw Error('This download contained no dictionary entries.')
      db.exec('BEGIN IMMEDIATE')
      db.prepare('DELETE FROM senses WHERE lang=?').run(code)
      db.prepare(
        'INSERT INTO senses SELECT ?,term,json_group_array(json(definition)) FROM staged GROUP BY term'
      ).run(code)
      db.prepare('INSERT OR REPLACE INTO packs VALUES(?,?)').run(code, Date.now())
      db.exec('COMMIT')
    } finally {
      db.close()
    }
  })()
    .catch((e) => {
      job.error = e.message
    })
    .finally(() => {
      job.running = false
    })
}
export async function definition(dir: string, term: string, language: string) {
  if (!term.trim() || term.length > 160) throw Error('Enter a word or short phrase.')
  const db = open(dir)
  try {
    const rows = db
      .prepare('SELECT lang,definition FROM senses WHERE term=? ORDER BY lang=? DESC')
      .all(normalizeTerm(term), language)
    if (rows.length)
      return rows.map((r) => ({
        language: String(r.lang),
        name: languages[String(r.lang)],
        senses: (JSON.parse(String(r.definition)) as Sense[][]).flat().slice(0, 80),
        source: 'Wiktionary via Kaikki.org'
      }))
  } finally {
    db.close()
  }
  const res = await fetch(
    'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term.trim()),
    { signal: AbortSignal.timeout(8000), redirect: 'error' }
  )
  if (res.status === 404) return []
  if (!res.ok) throw Error('Dictionary unavailable. Previously saved words are available offline.')
  const data = (await res.json()) as Record<
    string,
    { language: string; partOfSpeech: string; definitions: { definition: string }[] }[]
  >
  return Object.entries(data)
    .filter(([, entries]) => Array.isArray(entries))
    .map(([code, entries]) => ({
      language: code,
      name: entries[0]?.language ?? code,
      source: 'English Wiktionary',
      senses: entries
        .flatMap((e) =>
          (e.definitions ?? []).flatMap((d) => {
            const meaning = htmlToText(d.definition).trim().slice(0, 5000)
            return meaning ? [{ pos: e.partOfSpeech, meaning }] : []
          })
        )
        .slice(0, 80)
    }))
    .filter((r) => r.senses.length)
    .sort((a, b) => Number(b.language === language) - Number(a.language === language))
}
