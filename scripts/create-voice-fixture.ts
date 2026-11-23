// Synthetic speech only: node scripts/create-voice-fixture.ts (macOS + FFmpeg).
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = resolve('data/live-tests/voice')
const text = 'Project Aurora decided to launch on December twelve. The copper orchard budget is three hundred twelve dollars. This is synthetic speech for an integration test.'
mkdirSync(directory, { recursive: true })
const speech = spawnSync('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-o', `${directory}/aurora-live.aiff`, text], { encoding: 'utf8' })
if (speech.status !== 0 || statSync(`${directory}/aurora-live.aiff`).size < 1024) throw new Error('macOS synthetic voice did not produce audio. Run outside the speech sandbox or provide a synthetic WAV fixture.')
const converted = spawnSync(process.env.WORLDVIEW_FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${directory}/aurora-live.aiff`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', `${directory}/aurora-live.wav`], { encoding: 'utf8' })
if (converted.status !== 0) throw new Error('FFmpeg could not convert the generated synthetic voice.')
writeFileSync(`${directory}/expected.txt`, text + '\n')
console.log(`Created synthetic speech at ${directory}/aurora-live.wav (${statSync(`${directory}/aurora-live.wav`).size} bytes).`)
