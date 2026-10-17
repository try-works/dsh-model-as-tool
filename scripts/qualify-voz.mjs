#!/usr/bin/env node
/**
 * The qualified voz STT run (GATE-GREEN-GAPS item 2).
 *
 * What this proves, and what it does not:
 *
 * - It proves the REAL engine: the Desert Ant Voz 3.6.0 model over ONNX Runtime,
 *   reached through the extension's own `./tool-mode` provider exactly the way the
 *   host dispatches it (create → load → invoke with {audio_path} + the host-shaped
 *   invocation context). Weights are the vendor's, cached under ~/.cache.
 * - The recordings are SYSTEM-SYNTHESIZED speech (Windows System.Speech), NOT a
 *   real-speaker corpus. The record states this in its provenance field, and the
 *   'real-speaker corpus' clause remains an honest recorded remainder — this script
 *   never pretends otherwise.
 *
 * Modes:
 *   node scripts/qualify-voz.mjs [--out <dir>] [--keep-wavs]
 *     Full run: synthesize, transcribe, assert, write the qualification record.
 *   node scripts/qualify-voz.mjs --smoke
 *     The reproducible smoke assertion: same run, no record written.
 *   (internal) --warm-probe
 *     A FRESH PROCESS measuring the cached-weights load (weights on disk, no
 *     module or page cache). Both load figures record disk-cached loads; this
 *     script never claims a cold-disk measurement, because producing one would
 *     require deleting the vendor-managed cache.
 *
 * Exit codes:
 *   0  every strict assertion passed
 *   1  a strict assertion failed (a real failure)
 *   2  the weights or dependencies are missing: SKIPPED-weights-missing, not a fake pass
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { parseWave } from './voz-wav.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const EXTENSION_LIB = join(REPO_ROOT, 'packages', 'extension-desert-ant-voz', 'lib', 'index.js')
// VOZ_CACHE_DIR lets a test point at an empty dir to exercise the SKIPPED path.
const CACHE_DIR = process.env.VOZ_CACHE_DIR ?? join(homedir(), '.cache', 'desert-ant-models')
const QUALIFICATION_DIR = join(REPO_ROOT, 'docs', 'tool-mode', 'qualification')

const VOZ_PACKAGE = '@desert-ant-labs/voz'
const ORT_PACKAGE = 'onnxruntime-node'
const EXTENSION_ID = '@try-works/extension-desert-ant-voz'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const index = args.indexOf(name)
  return index === -1 || args[index + 1] === undefined ? undefined : args[index + 1]
}
const SMOKE = flag('--smoke')
const WARM_PROBE = flag('--warm-probe')
const KEEP_WAVS = flag('--keep-wavs')
const OUT_DIR = resolve(REPO_ROOT, valueOf('--out') ?? join('docs', 'tool-mode', 'qualification'))

/**
 * The model files the voz package actually loads (platform-node.js:
 * `<cache>/desert-ant-models/<repo>/<revision>/web/<file>`).
 *
 * The readiness check requires THESE files at sane sizes — not just any file
 * under the cache. A stray 4 KB meta.json alone must report SKIPPED, because
 * the load that follows would fail for a real reason rather than for the
 * honest missing-weights reason this script's exit 2 exists for.
 */
const REQUIRED_WEIGHTS = [
  { file: 'encoder.onnx.data', minBytes: 300 * 1024 * 1024 },
  { file: 'decoder.webgpu.onnx', minBytes: 20 * 1024 * 1024 },
  { file: 'embedding.f16', minBytes: 5 * 1024 * 1024 },
  { file: 'encoder.onnx', minBytes: 512 * 1024 },
  { file: 'vocab.json', minBytes: 1024 },
  { file: 'meta.json', minBytes: 1 },
]

/** Resolve the vendor cache web/ directory the weights actually live in. */
function resolveWeightFiles() {
  if (!existsSync(CACHE_DIR)) return undefined
  const base = join(CACHE_DIR, 'desert-ant-labs', 'voz')
  if (!existsSync(base)) return undefined
  try {
    for (const revision of readdirSync(base)) {
      const web = join(base, revision, 'web')
      if (!existsSync(web)) continue
      const found = REQUIRED_WEIGHTS.map(({ file, minBytes }) => {
        const path = join(web, file)
        let bytes = 0
        try {
          bytes = statSync(path).size
        } catch {
          return undefined
        }
        return bytes >= minBytes ? { file, path, bytes } : undefined
      })
      if (found.every(Boolean)) return { revision, web, files: found }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** The weights are present when the model's actual files sit in the cache. */
function weightsCached() {
  return resolveWeightFiles() !== undefined
}

/** Report the missing precondition and stop with the SKIPPED exit code. */
function skip(reason) {
  process.stdout.write(`SKIPPED-weights-missing: ${reason}\n`)
  process.stdout.write(
    `The voz weights are downloaded by the model package on first load into ${CACHE_DIR}\n`
    + `(files: ${REQUIRED_WEIGHTS.map(entry => entry.file).join(', ')} under desert-ant-labs/voz/<revision>/web/).\n`
    + `Install ${VOZ_PACKAGE} and ${ORT_PACKAGE} beside the extension, then run once online to cache them.\n`,
  )
  process.exit(2)
}

/** Resolve whether the two optional dependencies exist beside the extension. */
function dependenciesPresent() {
  try {
    // Resolvable from the repository root, where the extension resolves its imports.
    const fromRoot = (specifier) => import.meta.resolve(specifier, pathToFileURL(join(REPO_ROOT, 'package.json')).href)
    fromRoot(VOZ_PACKAGE)
    fromRoot(ORT_PACKAGE)
    return true
  } catch {
    return false
  }
}

/** Write a 1.2 s silence WAV (16 kHz, mono, 16-bit PCM). */
function writeSilenceWav(path) {
  const sampleRate = 16000
  const seconds = 1.2
  const samples = Math.floor(sampleRate * seconds)
  const dataBytes = samples * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(dataBytes)]))
  return { path, bytes: 44 + dataBytes }
}

/** Synthesize the spoken utterances via the PowerShell helper. */
function synthesize(outDir) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPT_DIR, 'synthesize-voz-utterances.ps1'), '-OutDir', outDir],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0) {
    throw new Error(`utterance synthesis failed: ${result.stderr ?? result.stdout ?? 'unknown'}`)
  }
  // PowerShell's UTF8 encoding emits a BOM; strip it before parsing.
  const voices = JSON.parse(readFileSync(join(outDir, 'voices.json'), 'utf8').replace(/^\uFEFF/, ''))
  return voices
}

/** The host-shaped invocation context the qualification speaks. */
function invocationContext(invocationId) {
  return {
    invocationId,
    signal: new AbortController().signal,
    limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
    // The qualification owns its own files, so the canonical path is the candidate.
    resolvePath: (candidate) => candidate,
  }
}

/** The minimal ExtensionContextV1 the qualification supplies. */
function extensionContext() {
  return {
    extensionId: EXTENSION_ID,
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { async read() { return undefined }, async write() {}, directory: '' },
    logger: { log(level, message, fields) { if (level !== 'debug') process.stderr.write(`[${level}] ${message}\n`) } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** Load the extension and build the voz provider, exactly as the host dispatches. */
async function buildProvider() {
  const module = await import(pathToFileURL(EXTENSION_LIB).href)
  const declared = module.default
  if (declared === undefined || typeof declared.create !== 'function') {
    throw new Error(`the built extension at ${EXTENSION_LIB} does not default-export create(context)`)
  }
  const instance = await declared.create(extensionContext())
  return { instance, provider: await instance.createProvider({ modelId: 'voz' }) }
}

/** One measured load, in a fresh provider instance. */
async function measureLoad() {
  const { provider } = await buildProvider()
  const started = process.hrtime.bigint()
  await provider.load({ assets: {}, signal: new AbortController().signal })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { provider, loadMs: ms }
}

/**
 * A FRESH PROCESS loading with the weights already on disk.
 *
 * Honest label: this measures a cached-weights load that still pays Node
 * startup and module import — it is NOT a warm-vs-cold disk comparison, and
 * this script never claims one (no cold-disk figure exists here without
 * deleting the vendor-managed cache).
 */
function freshProcessCachedLoadMs() {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--warm-probe'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0) {
    throw new Error(`the fresh-process probe failed: ${result.stderr ?? result.stdout ?? 'unknown'}`)
  }
  const line = (result.stdout ?? '').trim().split(/\r?\n/).find(entry => entry.startsWith('WARM-LOAD '))
  const parsed = JSON.parse((line ?? '{}').slice('WARM-LOAD '.length))
  return parsed.loadMs
}

/** Transcribe one file through the REAL provider. */
async function transcribe(provider, wavPath, includeWords = true) {
  const started = process.hrtime.bigint()
  const value = await provider.invoke({
    input: { audio_path: wavPath, include_words: includeWords },
    context: invocationContext(`qualify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
  })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { value, transcribeMs: ms }
}

/** A WAV's data payload duration in seconds — chunk-walked, never fixed offsets. */
function wavSeconds(path) {
  const wave = parseWave(readFileSync(path))
  if (wave.audioFormat !== 1) throw new Error(`${path}: audio format ${wave.audioFormat} is not PCM`)
  return wave.durationSeconds
}

async function main() {
  if (WARM_PROBE) {
    if (!dependenciesPresent()) skip(`${VOZ_PACKAGE} or ${ORT_PACKAGE} does not resolve from the repository root`)
    const { loadMs } = await measureLoad()
    process.stdout.write(`WARM-LOAD ${JSON.stringify({ loadMs })}\n`)
    process.exit(0)
  }

  if (!dependenciesPresent()) skip(`${VOZ_PACKAGE} or ${ORT_PACKAGE} does not resolve from the repository root`)
  const resolved = resolveWeightFiles()
  if (resolved === undefined) {
    skip(
      `the voz model files are not cached under ${CACHE_DIR} (expected ${REQUIRED_WEIGHTS.map(entry => entry.file).join(', ')} `
      + `under desert-ant-labs/voz/<revision>/web/)`,
    )
  }

  const temp = join(OUT_DIR, `.voz-wavs-${process.pid}`)
  mkdirSync(temp, { recursive: true })
  try {
    const voices = synthesize(temp)
    const silence = writeSilenceWav(join(temp, 'silence.wav'))

    /**
     * LOAD MEASUREMENTS, honestly labeled. Both are CACHED-WEIGHTS loads — the
     * vendor-managed cache is a precondition of this run — so neither is a
     * cold-disk figure:
     *
     * - freshProcessCachedLoadMs: a fresh Node process pays startup + module
     *   import + weights read from disk.
     * - firstInProcessLoadMs: this process's first load (modules already
     *   imported, weights read from disk).
     * - sameProcessReloadMs: a second provider load in this process (modules +
     *   OS page cache warm).
     *
     * A true cold-disk measurement would require deleting the vendor cache,
     * which this qualification does not do and will not claim.
     */
    const first = await measureLoad()
    const reload = await measureLoad()
    const freshMs = freshProcessCachedLoadMs()

    const utterances = [
      {
        id: 'english',
        utterance: voices.english.utterance,
        wav: join(temp, 'english.wav'),
        includeWords: true,
        assert: (value) => ({
          pass: (value.text ?? '').toLowerCase().includes('quick brown fox'),
          detail: value.text,
        }),
      },
      {
        id: 'german',
        utterance: voices.german.utterance,
        wav: join(temp, 'german.wav'),
        includeWords: true,
        // Judged STRICTLY only when a German voice actually spoke it; a substituted
        // voice renders the words with foreign phonetics, so that run records the
        // outcome instead of failing on the voice gap.
        assert: (value) => ({
          pass: (value.text ?? '').toLowerCase().includes('das ist ein test'),
          detail: value.text,
        }),
      },
      {
        id: 'silence',
        utterance: '(synthesized silence)',
        wav: silence.path,
        includeWords: true,
        assert: (value) => ({
          pass: (value.text ?? '').trim().length === 0 || (value.wordCount ?? 0) === 0,
          detail: value.text ?? '',
        }),
      },
    ]

    const results = []
    for (const utterance of utterances) {
      const { value, transcribeMs } = await transcribe(first.provider, utterance.wav, utterance.includeWords)
      const verdict = utterance.assert(value)
      // A voice-substituted German run is recorded, never faked as a judged pass.
      const strict = !(utterance.id === 'german' && voices.german.substituted === true)
      const audioSeconds = wavSeconds(utterance.wav)
      const wallSeconds = transcribeMs / 1000
      results.push({
        id: utterance.id,
        utterance: utterance.utterance,
        wavBytes: readFileSync(utterance.wav).length,
        wavSha256: createHash('sha256').update(readFileSync(utterance.wav)).digest('hex'),
        // Chunk-walked RIFF duration (scripts/voz-wav.mjs), not a fixed offset.
        audioSeconds,
        transcript: value.text ?? '',
        wordCount: value.wordCount ?? 0,
        words: value.words ?? [],
        transcribeMs,
        /**
         * The vendor package's own realtime figure, attributed as such. This
         * script also computes the ratio INDEPENDENTLY in both directions so a
         * reader can see which convention the vendor's number follows.
         */
        vendorRealtimeFactor: {
          value: value.realtimeFactor ?? null,
          source: `reported by ${VOZ_PACKAGE}`,
        },
        scriptMeasured: {
          audioSeconds,
          wallSeconds,
          ratioAudioToWall: audioSeconds / wallSeconds,
          ratioWallToAudio: wallSeconds / audioSeconds,
        },
        assertion: {
          expected: utterance.id === 'english'
            ? 'the transcript contains "quick brown fox"'
            : utterance.id === 'german'
              ? 'the transcript contains "Das ist ein Test"'
              : 'the transcript is empty (silence)',
          pass: strict ? verdict.pass : null,
          judged: strict,
          note: strict ? '' : `not judged: ${voices.german.note}`,
        },
      })
    }

    const failures = results.filter(entry => entry.assertion.judged && entry.assertion.pass !== true)
    const judgedCount = results.filter(entry => entry.assertion.judged).length
    const unjudgedCount = results.length - judgedCount
    const vozVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', VOZ_PACKAGE, 'package.json'), 'utf8')).version
    const ortVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', ORT_PACKAGE, 'package.json'), 'utf8')).version
    const extensionVersion = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'extension-desert-ant-voz', 'package.json'), 'utf8'),
    ).version
    const synthesizerPath = join(SCRIPT_DIR, 'synthesize-voz-utterances.ps1')
    const weights = resolved.files.map(({ file, path, bytes }) => ({
      file,
      bytes,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }))
    const record = {
      model: {
        id: 'voz',
        package: VOZ_PACKAGE,
        version: vozVersion,
        engine: `ONNX Runtime (${ORT_PACKAGE} ${ortVersion})`,
        platform: { os: process.platform, arch: process.arch, accelerator: 'cpu' },
        extension: EXTENSION_ID,
        extensionVersion,
        extensionEntry: EXTENSION_LIB,
        cache: CACHE_DIR,
        cacheRevision: resolved.revision,
      },
      weights: {
        note:
          'The files the vendor package actually loaded, DISCOVERED and hashed at qualification time from its legacy '
          + 'vendor-managed cache. These hashes record what ran — they are NOT an immutable pin: the cache is written '
          + 'by @desert-ant-labs/voz itself and may change between runs, and the extension\'s models.lock.json declares '
          + 'no asset list for it. A re-run re-measures; nothing here is trusted across runs.',
        files: weights,
      },
      load: {
        freshProcessCachedLoadMs: freshMs,
        firstInProcessLoadMs: first.loadMs,
        sameProcessReloadMs: reload.loadMs,
        weightsState: 'cached on disk (vendor-managed cache); no cold-disk figure is claimed — producing one would require deleting the cache',
      },
      provenance: {
        recordings: 'SYNTHESIZED SPEECH (Windows System.Speech), not a real-speaker corpus',
        engine: voices.engine,
        synthesizer: {
          script: 'scripts/synthesize-voz-utterances.ps1',
          sha256: createHash('sha256').update(readFileSync(synthesizerPath)).digest('hex'),
        },
        note: 'The real-speaker corpus clause of the STT qualification remains an honest recorded remainder; this run proves the real-engine smoke qualification only.',
      },
      voices,
      utterances: results,
      judged: { judgedCount, unjudgedCount },
      verdict: failures.length > 0 ? 'fail' : unjudgedCount > 0 ? 'smoke-partial' : 'smoke-pass',
      verdictNote:
        'A SMOKE qualification over SYSTEM-SYNTHESIZED speech, never full conformance: it proves the real engine runs and '
        + 'the assertions pass on a deterministic corpus. The real-speaker-corpus clause remains a recorded remainder, and '
        + '"smoke-pass"/"smoke-partial" is deliberately weaker than any conformance claim.',
      recordedAt: new Date().toISOString(),
    }

    if (!SMOKE) {
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(join(OUT_DIR, 'voz.json'), JSON.stringify(record, null, 2) + '\n')
    } else {
      process.stdout.write(
        `SMOKE ${record.verdict}: fresh ${record.load.freshProcessCachedLoadMs.toFixed(0)} ms, `
        + `reload ${record.load.sameProcessReloadMs.toFixed(0)} ms, judged ${judgedCount}/${results.length}\n`,
      )
    }
    for (const entry of results) {
      process.stdout.write(
        `[${entry.id}] ${entry.assertion.pass === true ? 'PASS' : entry.assertion.judged === false ? 'RECORDED' : 'FAIL'}: `
        + `${JSON.stringify(entry.transcript)}\n`,
      )
    }
    if (failures.length > 0) {
      process.stderr.write(`QUALIFICATION FAILED: ${failures.map(entry => entry.id).join(', ')}\n`)
      process.exit(1)
    }
    process.exit(0)
  } finally {
    if (!KEEP_WAVS) rmSync(temp, { recursive: true, force: true })
  }
}

void main()
