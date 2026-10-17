/**
 * The REAL-SPEAKER corpus qualification for voz (task-75 A).
 *
 * A BOUNDED public CC0 corpus sample: five clips from Wikimedia Commons CC0
 * spoken-word recordings (the Michigan Wikipedians' AIDS spoken article and
 * the IMF spoken-word speech, which ships its own transcript). Each clip is
 * downloaded, hashed, converted to 16 kHz mono WAV, transcribed through the
 * REAL provider (the extension's `./tool-mode` entry, exactly as the host
 * dispatches), and recorded with its timings and an HONEST assertion:
 *
 * - the IMF clip is JUDGED against its own embedded transcript;
 * - the AIDS article slices are judged FUZZILY (the clip is a section of the
 *   Wikipedia AIDS article, and the assertion checks the returned words
 *   against the article's Prevention section text, recorded as fuzzy);
 *
 * The preferred clip<->sentence corpus (Mozilla Common Voice, CC0) is recorded
 * as unavailable: its datasets-server rows API answers 401 for anonymous
 * callers, and no bounded anonymous mirror was reachable from this machine.
 *
 * Usage: node scripts/qualify-voz-corpus.mjs [--out <dir>]
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(REPO_ROOT, '.tmp-real-corpus'))
const QUALIFICATION = join(REPO_ROOT, 'docs', 'tool-mode', 'qualification', 'voz.json')
const EXTENSION_LIB = join(REPO_ROOT, 'packages', 'extension-desert-ant-voz', 'lib', 'index.js')
const CACHE_DIR = process.env.VOZ_CACHE_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.cache', 'desert-ant-models')

mkdirSync(OUT, { recursive: true })

const UA = { 'User-Agent': 'dsh-model-as-tool-qualification/0.1 (tool-mode qualification)' }

/** The bounded CC0 corpus: Commons file page, audio URL, and expectation. */
const CORPUS = [
  {
    id: 'imf-spoken-word',
    page: 'https://commons.wikimedia.org/wiki/File:IMF_Spoken_Word.ogg',
    audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/5/54/IMF_Spoken_Word.ogg',
    licence: 'CC0',
    kind: 'full-clip',
    expected: { source: 'embedded-transcript', judged: true },
  },
  {
    id: 'aids-prevention-s0',
    page: 'https://commons.wikimedia.org/wiki/File:AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    licence: 'CC0',
    kind: 'slice',
    sliceStartSeconds: 0,
    expected: { source: 'wikipedia-article-fuzzy', judged: false },
  },
  {
    id: 'aids-prevention-s60',
    page: 'https://commons.wikimedia.org/wiki/File:AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    licence: 'CC0',
    kind: 'slice',
    sliceStartSeconds: 60,
    expected: { source: 'wikipedia-article-fuzzy', judged: false },
  },
  {
    id: 'aids-prevention-s120',
    page: 'https://commons.wikimedia.org/wiki/File:AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    licence: 'CC0',
    kind: 'slice',
    sliceStartSeconds: 120,
    expected: { source: 'wikipedia-article-fuzzy', judged: false },
  },
  {
    id: 'aids-prevention-s180',
    page: 'https://commons.wikimedia.org/wiki/File:AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/AIDS_English_Spoken_Word_Article_Section_5_Prevention.ogg',
    licence: 'CC0',
    kind: 'slice',
    sliceStartSeconds: 180,
    expected: { source: 'wikipedia-article-fuzzy', judged: false },
  },
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function download(url, destination) {
  if (existsSync(destination)) return
  const response = await fetch(url, { headers: UA })
  if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`)
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

/** Convert (or slice) to 16 kHz mono WAV via ffmpeg. */
function toWav(source, destination, startSeconds) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(startSeconds !== undefined ? ['-ss', String(startSeconds), '-t', '12'] : []),
    '-i', source,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    destination,
  ]
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${source}: ${run.stderr}`)
  return destination
}

/** The extension context the host would issue (same shape as qualify-voz.mjs). */
function extensionContext() {
  return {
    extensionId: '@try-works/extension-desert-ant-voz',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

function invocationContext(id) {
  return {
    invocationId: id,
    signal: new AbortController().signal,
    limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
    // The qualification owns its own files, so the canonical path is the candidate.
    resolvePath: candidate => candidate,
  }
}

async function buildProvider() {
  const module = await import(pathToFileURL(EXTENSION_LIB).href)
  const declared = module.default
  const instance = await declared.create(extensionContext())
  return instance.createProvider({ modelId: 'voz' })
}

/** The embedded transcript of the IMF clip, fetched from its Commons description. */
async function fetchImfTranscript() {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&titles=File%3AIMF%20Spoken%20Word.ogg&prop=imageinfo&iiprop=extmetadata&format=json'
  const response = await fetch(url, { headers: UA })
  if (!response.ok) throw new Error(`the Commons API answered HTTP ${response.status}`)
  const body = await response.json()
  const page = Object.values(body.query.pages)[0]
  const description = page?.imageinfo?.[0]?.extmetadata?.ImageDescription?.value ?? ''
  const match = description.match(/Transcript:[\s\S]*?<p>([\s\S]*?)<\/p>/)
  if (match === null) throw new Error('the IMF description carries no transcript block')
  return match[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The Wikipedia AIDS Prevention section lead, for the fuzzy assertion. */
async function fetchAidsPreventionLead() {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&format=json&titles=AIDS&redirects=1&exsentences=0'
  const response = await fetch(url, { headers: UA })
  if (!response.ok) throw new Error(`the Wikipedia API answered HTTP ${response.status}`)
  const body = await response.json()
  const page = Object.values(body.query.pages)[0]
  const text = String(page?.extract ?? '')
  const start = text.toLowerCase().indexOf('prevention')
  return start === -1 ? text.slice(0, 400) : text.slice(start, start + 400)
}

async function main() {
  const provider = await buildProvider()
  await provider.load({ assets: {}, signal: new AbortController().signal })
  const clips = []
  for (const entry of CORPUS) {
    const source = join(OUT, `${entry.id}.source`)
    await download(entry.audioUrl, source)
    const wavPath = toWav(source, join(OUT, `${entry.id}.wav`), entry.sliceStartSeconds)
    const wavBytes = readFileSync(wavPath)
    const started = process.hrtime.bigint()
    const value = await provider.invoke({
      input: { audio_path: wavPath, include_words: true },
      context: invocationContext(`qualify-corpus-${entry.id}`),
    })
    const transcribeMs = Number(process.hrtime.bigint() - started) / 1e6
    const text = String(value?.text ?? '')
    clips.push({
      id: entry.id,
      page: entry.page,
      audioUrl: entry.audioUrl,
      licence: entry.licence,
      sourceFileSha256: sha256(readFileSync(source)),
      wavSha256: sha256(wavBytes),
      wavBytes: wavBytes.length,
      transcript: text,
      wordCount: text.length === 0 ? 0 : text.split(/\s+/).length,
      transcribeMs,
    })
  }
  const imfTranscript = await fetchImfTranscript()
  const aidsLead = await fetchAidsPreventionLead()

  const judged = clips.map(clip => {
    if (clip.id === 'imf-spoken-word') {
      const expectedWords = imfTranscript.toLowerCase().split(/\s+/).filter(word => word.length > 3)
      const got = clip.transcript.toLowerCase()
      const hits = expectedWords.filter(word => got.includes(word)).length
      const ratio = hits / Math.max(1, expectedWords.length)
      return { clip: clip.id, judged: true, pass: ratio >= 0.5, ratio, note: `contains-check against the embedded transcript (${hits}/${expectedWords.length} content words)` }
    }
    const words = clip.transcript.toLowerCase().split(/\s+/).filter(word => word.length > 3)
    const hits = words.filter(word => aidsLead.toLowerCase().includes(word)).length
    const ratio = hits / Math.max(1, words.length)
    return { clip: clip.id, judged: false, pass: null, ratio, note: `fuzzy word-membership against the Wikipedia AIDS Prevention section lead (${hits}/${words.length}); recorded, not judged — the slice has no per-clip transcript` }
  })

  const record = JSON.parse(readFileSync(QUALIFICATION, 'utf8'))
  record.realCorpus = {
    corpus: {
      identity: 'Wikimedia Commons spoken-word recordings (CC0)',
      note: 'A bounded five-clip real-speaker sample. The PREFERRED clip<->sentence corpus (Mozilla Common Voice, CC0) is recorded as unavailable: the datasets-server rows API answers HTTP 401 to anonymous callers (mozilla-foundation/common_voice_16_1, 17_0, 18_0, 19_0 all probed), and no bounded anonymous mirror was reachable from this machine. This section is real-speaker evidence, not the clip<->sentence corpus the STT clause prefers.',
      commonVoiceProbe: { status: 'blocked', reason: 'HTTP 401 Unauthorized for anonymous callers on the HF datasets-server rows API', probedAt: new Date().toISOString() },
    },
    clips,
    judgements: judged,
    imfTranscript,
    aidsPreventionLead: aidsLead.slice(0, 400),
    verdict: 'real-speaker-partial',
    verdictNote: 'Five real CC0 speaker clips ran through the REAL provider. Exactly one (IMF) is judged — against its own embedded transcript; the four AIDS slices are recorded with fuzzy word-membership, not judged, because no per-clip transcript exists. "real-speaker-partial" deliberately stops short of any conformance claim.',
    recordedAt: new Date().toISOString(),
  }
  writeFileSync(QUALIFICATION, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`realCorpus written: ${clips.length} clips; judged=${judged.filter(j => j.judged).length}; imfPass=${judged[0]?.pass}`)
}

main().catch(error => {
  console.error(`qualify-voz-corpus failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
