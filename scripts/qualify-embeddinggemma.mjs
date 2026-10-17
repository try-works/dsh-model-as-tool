#!/usr/bin/env node
/**
 * The qualified EmbeddingGemma text run (GATE-GREEN-GAPS item 3, text backbone).
 *
 * What this proves, and what it does not:
 *
 * - It proves the REAL engine: the pinned EmbeddingGemma 2 ONNX conversion, its shipped
 *   GemmaTokenizer, and the extension's own wired text path (onnxruntime-node CPU EP) —
 *   sentence-pair sanity in the real 768-dimensional space, the MOD-04 reductions, and the
 *   three tool payloads, measured end to end.
 * - It fetches EXACTLY the five pinned text-backbone files (onnx/model.onnx +
 *   onnx/model.onnx_data + tokenizer.json + tokenizer_config.json + config.json) and
 *   verifies every byte against the SHA-256 recorded in models.lock.json. No vision or
 *   audio artifact is fetched — the MOD-02 group boundary, observed not just asserted.
 * - The vision/audio encoders, the media decoders, and any real-speaker/media corpus
 *   remain honest recorded remainders; this run claims only the text backbone.
 *
 * Modes:
 *   node scripts/qualify-embeddinggemma.mjs [--out <dir>] [--reuse-cache]
 *     Full run: fetch (or verify), load, measure, assert, write the qualification record.
 *   node scripts/qualify-embeddinggemma.mjs --smoke
 *     The reproducible smoke assertion: same run, no record written.
 *
 * Exit codes:
 *   0  every strict assertion passed
 *   1  a strict assertion failed (a real failure)
 *   2  the artifacts are missing and could not be fetched: SKIPPED-artifacts-missing
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const EXTENSION_LIB = join(REPO_ROOT, 'packages', 'extension-embeddinggemma', 'lib', 'index.js')

const REPO = 'onnx-community/embeddinggemma-2-ONNX'
const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
const BASE_URL = `https://huggingface.co/${REPO}/resolve/${REVISION}`

/** The PINNED text-backbone files, exactly as models.lock.json records them. */
const PINNED = [
  { file: 'onnx/model.onnx', bytes: 421421, sha256: 'bc47de15f81208a5c99e5ab10f746d5e33b51ea228b7dc0bef9c133a94f1c1c3' },
  { file: 'onnx/model.onnx_data', bytes: 1084170240, sha256: '9fd452bfc6916e5a92f080f8dada35598ca4512b21c65897d4c5974d5f9630a2' },
  { file: 'tokenizer.json', bytes: 32170510, sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4' },
  { file: 'tokenizer_config.json', bytes: 1599, sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874' },
  { file: 'config.json', bytes: 5031, sha256: '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d' },
]

/** The PINNED media files (vision + audio encoders and their processor configs). */
const PINNED_MEDIA = [
  { file: 'onnx/vision_encoder.onnx', bytes: 121253, sha256: 'a3fb44f8b5b152cfee6afe16e2cd69e774b7e1d3b822d1db1190ddf7b08b575e' },
  { file: 'onnx/vision_encoder.onnx_data', bytes: 671026176, sha256: 'ca8d28c99feb8129618f141978a27adae25090e0dadb68a30c235e191c01e37e' },
  { file: 'onnx/audio_encoder.onnx', bytes: 204577, sha256: 'e0a62590c49949fe0b1410f5dc52c92a185abb4c4e69e2c50a4e316103fdbc09' },
  { file: 'onnx/audio_encoder.onnx_data', bytes: 1172750848, sha256: '6943b910d1d1e9b5dffd4ccad63f61aa308ad10b70ed128bb61886b119da1e3a' },
  { file: 'processor_config.json', bytes: 1788, sha256: '168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c' },
  { file: 'preprocessor_config.json', bytes: 560, sha256: '9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa' },
]

const CACHE_DIR = process.env.EMBEDDINGGEMMA_CACHE_DIR
  ?? join(homedir(), '.cache', 'embeddinggemma-2', 'onnx-community', REVISION)
const QUALIFICATION_DIR = join(REPO_ROOT, 'docs', 'tool-mode', 'qualification')

const args = process.argv.slice(2)
const SMOKE = args.includes('--smoke')
const OFFLINE = args.includes('--offline')
// --no-audio: do not fetch the audio group at all; the run records the measured
// partial (current on-disk bytes) as an honest not-run remainder. This is the
// bounded mode for a host whose CDN connection cannot complete the 1.1 GB file.
const NO_AUDIO = args.includes('--no-audio')
const OUT_DIR = resolve(REPO_ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/tool-mode/qualification')

/**
 * One curl transfer; the HTTP status and the FINAL response's Content-Range are
 * returned, the bytes land in `outFile`.
 *
 * NO --retry here: curl's internal retry RESTARTS the transfer and TRUNCATES the
 * partial file, so a mid-transfer reset leaves 0 bytes and the caller's resume
 * loop can never progress. The caller IS the retry, re-requesting from +have.
 */
function curlTransfer(fromBytes, outFile, url) {
  const headers = `${outFile}.headers`
  const args = ['-s', '-L', '-D', headers, '-w', '%{http_code}', '-o', outFile]
  if (fromBytes > 0) args.push('-r', `${fromBytes}-`)
  args.push(url)
  const result = spawnSync('curl.exe', args, { encoding: 'utf8', windowsHide: true })
  const status = Number((result.stdout ?? '').trim().split(/\s+/).pop())
  let contentRange
  if (existsSync(headers)) {
    // The dump carries every hop's headers; the LAST well-formed Content-Range line
    // is the final response's, which is the one that must describe the appended
    // bytes. A line whose digit groups did not capture is skipped defensively.
    const lines = readFileSync(headers, 'utf8').split(/\r?\n/)
    let lastMatch
    for (const line of lines) {
      const match = /^content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(line)
      if (match !== null && match[1] !== undefined && match[2] !== undefined) lastMatch = match
    }
    if (lastMatch !== undefined) {
      contentRange = { start: Number(lastMatch[1]), end: Number(lastMatch[2]), total: lastMatch[3] === '*' ? undefined : Number(lastMatch[3]) }
    }
    rmSync(headers, { force: true })
  }
  return { status: Number.isFinite(status) ? status : 0, contentRange }
}

/**
 * Verify one cached file against its pin, or download it with the VERIFIED
 * resume discipline (measured against this exact CDN):
 *
 * - `curl -C -` is FORBIDDEN here: the signed CDN URL 302s and, when it ignores
 *   Range, curl appends the FULL body — the oversize corruption signature. A
 *   file over the pinned size is always deleted and restarted, never resumed.
 * - A resume uses an explicit `-r <size>-` into a THROWAWAY piece file, and the
 *   piece is appended ONLY when the response was HTTP 206 AND the piece size is
 *   exactly the remainder (pinned - current).
 * - A 200 answer REPLACES the target outright (a fresh full download).
 * - Every transfer re-resolves the URL, so an expired signed URL is never reused.
 * - The final bytes are SHA-256-verified against the pin before the status is
 *   `fetched`; a mismatch deletes and restarts rather than pretending.
 */
function verifyOrFetch(pinned, label) {
  const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const target = join(CACHE_DIR, ...pinned.file.split('/'))
  if (existsSync(target)) {
    const size = statSync(target).size
    if (size === pinned.bytes) {
      if (sha256(target) === pinned.sha256) return { status: 'cached', ...pinned }
      rmSync(target, { force: true })
      process.stdout.write(`  ${label}: cached file fails the digest at the pinned size; restarting fresh\n`)
    } else if (size > pinned.bytes) {
      rmSync(target, { force: true })
      process.stdout.write(`  ${label}: cached file is OVERSIZE (${size} > ${pinned.bytes}); the -C - corruption signature, restarting fresh\n`)
    } else {
      process.stdout.write(`  ${label}: resuming a partial (${size}/${pinned.bytes})\n`)
    }
  } else {
    process.stdout.write(`  ${label}: fetching\n`)
  }
  if (OFFLINE) {
    // The offline mode makes the SKIPPED degradation testable without a network: a file
    // that is not already cached and verified can only be skipped, never faked.
    return { status: 'offline-missing', ...pinned, got: existsSync(target) ? statSync(target).size : 0 }
  }
  mkdirSync(dirname(target), { recursive: true })
  const piece = `${target}.piece`

  for (let attempt = 1; attempt <= 24; attempt++) {
    const current = existsSync(target) ? statSync(target).size : 0
    if (current === pinned.bytes) {
      if (sha256(target) === pinned.sha256) return { status: 'fetched', ...pinned }
      rmSync(target, { force: true })
      process.stdout.write(`  ${label}: full-size digest mismatch; restarting fresh\n`)
    } else if (current > pinned.bytes) {
      rmSync(target, { force: true })
      process.stdout.write(`  ${label}: oversize; restarting fresh\n`)
    }
    rmSync(piece, { force: true })
    const transfer = curlTransfer(current, piece, `${BASE_URL}/${pinned.file}`)
    const pieceSize = existsSync(piece) ? statSync(piece).size : 0
    if (transfer.status === 206) {
      /**
       * A partial-range answer is appended ONLY when BOTH the Content-Range origin
       * and the length are right: the range must start at the byte offset that was
       * requested (a wrong origin means the server answered a different span) and
       * end inside the pinned file, the total must name the pinned size, and the
       * piece must fit the remainder — a length check alone cannot tell a correct
       * resume from an answered-but-shifted range.
       */
      const range = transfer.contentRange
      const originOk = range !== undefined && range.start === current
      const spanOk = range !== undefined && range.end < pinned.bytes && (range.total === undefined || range.total === pinned.bytes)
      const fitsOk = pieceSize > 0 && pieceSize <= pinned.bytes - current
      if (originOk && spanOk && fitsOk) {
        appendFileSync(target, readFileSync(piece))
        process.stdout.write(`  ${label}: appended ${pieceSize} bytes (206, origin ${current}) -> ${current + pieceSize}/${pinned.bytes}\n`)
      } else {
        process.stdout.write(`  ${label}: discarding a 206 piece (${pieceSize} bytes; range ${JSON.stringify(range ?? null)}, remainder ${pinned.bytes - current})\n`)
      }
    } else if (transfer.status === 200) {
      // A full answer REPLACES the target when complete. A TRUNCATED 200 is a valid
      // PREFIX of the file (the transfer stopped early), so it is kept as the resume
      // base — the oversize guard above keeps this safe from the -C - corruption.
      if (pieceSize > 0 && pieceSize <= pinned.bytes) {
        rmSync(target, { force: true })
        renameSync(piece, target)
        process.stdout.write(`  ${label}: a 200 answer carried ${pieceSize}/${pinned.bytes} bytes; kept as the resume base\n`)
      } else {
        process.stdout.write(`  ${label}: a 200 answer carried ${pieceSize} bytes; discarding and retrying\n`)
      }
    } else {
      process.stdout.write(`  ${label}: HTTP ${status}; retrying\n`)
    }
    const now = existsSync(target) ? statSync(target).size : 0
    if (now === pinned.bytes) {
      if (sha256(target) === pinned.sha256) return { status: 'fetched', ...pinned }
      rmSync(target, { force: true })
      process.stdout.write(`  ${label}: full-size digest mismatch; restarting fresh\n`)
    }
    if (attempt === 24) return { status: 'failed', ...pinned, got: now }
  }
  return { status: 'failed', ...pinned, got: existsSync(target) ? statSync(target).size : 0 }
}

/** Report the missing-artifacts state and stop with the SKIPPED exit code. */
function skip(reason) {
  process.stdout.write(`SKIPPED-artifacts-missing: ${reason}\n`)
  process.stdout.write(
    `The pinned text-backbone files are fetched and verified by this script into ${CACHE_DIR}\n`
    + `(source: ${BASE_URL}). A run that cannot complete the pinned download reports this instead of a fake pass.\n`,
  )
  process.exit(2)
}

/** The host-shaped invocation context the qualification speaks. */
function invocationContext() {
  return {
    invocationId: 'qualify-embeddinggemma',
    signal: new AbortController().signal,
    limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
    resolvePath: candidate => candidate,
  }
}

/** The minimal ExtensionContextV1 the qualification supplies. */
function extensionContext() {
  return {
    extensionId: '@try-works/extension-embeddinggemma',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { async read() { return undefined }, async write() {}, directory: '' },
    logger: { log(level, message) { if (level !== 'debug') process.stderr.write(`[${level}] ${message}\n`) } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** PNG CRC-32, for the generated fixtures. */
function pngCrc(type, data) {
  const table = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table.push(c >>> 0)
  }
  const bytes = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const out = Buffer.alloc(4)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return out
}

/** One PNG chunk. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, pngCrc(type, data)])
}

/**
 * A generated RGB PNG fixture, 96x96 so the 960x672 canonical grid is reached
 * by a real (bicubic) upscale rather than a trivial copy. `pattern` chooses
 * solid (one color) or checkerboard (8x8 blocks of the color vs black).
 */
function generatedPng(pattern, red, green, blue) {
  const width = 96
  const height = 96
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(0, 12)
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    scanlines.writeUInt8(0, row)
    for (let x = 0; x < width; x += 1) {
      const dark = pattern === 'checker' && ((x >> 3) + (y >> 3)) % 2 === 1
      const offset = row + 1 + x * 3
      scanlines.writeUInt8(dark ? 0 : red, offset)
      scanlines.writeUInt8(dark ? 0 : green, offset + 1)
      scanlines.writeUInt8(dark ? 0 : blue, offset + 2)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** The generated video fixture frames: four 32x24 solid colors. */
const FRAMES_VIDEO = [
  { red: 200, green: 0, blue: 80 },
  { red: 40, green: 220, blue: 60 },
  { red: 10, green: 10, blue: 240 },
  { red: 240, green: 200, blue: 10 },
]

/** A RIFF chunk (fourcc + payload, padded to even length). */
function riffChunk(id, payload) {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'ascii')
  head.writeUInt32LE(payload.byteLength, 4)
  const pad = payload.byteLength & 1
  return Buffer.concat([head, payload, pad === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

/**
 * A generated RIFF/AVI container with UNCOMPRESSED DIB frames — the one
 * container+codec the bounded sampler implements. Same layout as the test
 * generator: avih + strl/strh/strf (BITMAPINFOHEADER, biCompression 0) + movi
 * '00db' chunks of bottom-up BGR24 rows padded to 4-byte boundaries.
 */
function generatedAvi(frames) {
  const width = 32
  const height = 24
  const fps = 2
  const stride = Math.ceil((width * 3) / 4) * 4
  const frameBytes = stride * height
  const moviParts = []
  for (const frame of frames) {
    const rows = Buffer.alloc(frameBytes)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = y * stride
        rows.writeUInt8(frame.blue, base + x * 3)
        rows.writeUInt8(frame.green, base + x * 3 + 1)
        rows.writeUInt8(frame.red, base + x * 3 + 2)
      }
    }
    moviParts.push(riffChunk('00db', rows))
  }
  const avih = Buffer.alloc(40)
  avih.writeUInt32LE(Math.round(1_000_000 / fps), 0)
  avih.writeUInt32LE(frames.length, 16)
  avih.writeUInt32LE(width, 32)
  avih.writeUInt32LE(height, 36)
  const strh = Buffer.alloc(56)
  strh.write('vids', 0, 'ascii')
  strh.write('DIB ', 4, 'ascii')
  strh.writeUInt32LE(frames.length, 20)
  strh.writeUInt32LE(Math.round(1_000_000 / fps), 24)
  const strf = Buffer.alloc(40)
  strf.writeUInt32LE(40, 0)
  strf.writeUInt32LE(width, 4)
  strf.writeUInt32LE(height, 8)
  strf.writeUInt16LE(1, 12)
  strf.writeUInt16LE(24, 14)
  strf.writeUInt32LE(0, 16)
  const hdrl = riffChunk('LIST', Buffer.concat([
    Buffer.from('hdrl', 'ascii'),
    riffChunk('avih', avih),
    riffChunk('LIST', Buffer.concat([Buffer.from('strl', 'ascii'), riffChunk('strh', strh), riffChunk('strf', strf)])),
  ]))
  const movi = riffChunk('LIST', Buffer.concat([Buffer.from('movi', 'ascii'), ...moviParts]))
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('AVI ', 'ascii'), hdrl, movi])
}

/** A generated 16 kHz PCM16 mono WAV fixture holding one sine. */
function generatedWav(frequency) {
  const rate = 16000
  const seconds = 1.2
  const frames = Math.floor(rate * seconds)
  const dataBytes = frames * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.alloc(dataBytes)
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin((2 * Math.PI * frequency * frame) / rate) * 0.4
    data.writeInt16LE(Math.round(value * 32767), frame * 2)
  }
  return Buffer.concat([header, data])
}

/** A generated 16 kHz PCM16 mono WAV concatenating tone segments. */
function generatedWavSegments(segments) {
  const rate = 16000
  const frames = segments.reduce((sum, segment) => sum + Math.floor(rate * segment.seconds), 0)
  const dataBytes = frames * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.alloc(dataBytes)
  let frame = 0
  for (const segment of segments) {
    const segmentFrames = Math.floor(rate * segment.seconds)
    for (let inner = 0; inner < segmentFrames; inner += 1, frame += 1) {
      const value = Math.sin((2 * Math.PI * segment.hz * inner) / rate) * 0.4
      data.writeInt16LE(Math.round(value * 32767), frame * 2)
    }
  }
  return Buffer.concat([header, data])
}

/** Build the provider over the built extension entry, as the host dispatches. */
async function buildProvider() {
  const module = await import(pathToFileURL(EXTENSION_LIB).href)
  const declared = module.default
  if (declared === undefined || typeof declared.create !== 'function') {
    throw new Error(`the built extension at ${EXTENSION_LIB} does not default-export create(context)`)
  }
  const instance = await declared.create(extensionContext())
  return { instance, provider: await instance.createProvider({ modelId: 'embeddinggemma-2' }) }
}

async function main() {
  if (!existsSync(EXTENSION_LIB)) {
    skip(`the built extension entry is missing at ${EXTENSION_LIB}; run npm run build:ext-embeddinggemma first`)
  }
  // The dependencies must resolve from the repository root.
  for (const specifier of ['onnxruntime-node', '@huggingface/transformers']) {
    try {
      if (typeof import.meta.resolve(specifier, pathToFileURL(join(REPO_ROOT, 'package.json')).href) !== 'string') throw new Error('unresolved')
    } catch {
      skip(`${specifier} does not resolve from the repository root; install it beside the extension`)
    }
  }

  /**
   * PER-GROUP DEGRADATION. The text backbone is the minimum: without it the whole
   * run is SKIPPED (exit 2). The vision and audio groups each verify independently;
   * a group whose artifacts cannot be verified is recorded as not-run rather than
   * faked, and the assertions that need it simply do not execute.
   */
  const textFetches = PINNED.slice(0, 5).map(pinned => verifyOrFetch(pinned, pinned.file))
  const textFailed = textFetches.find(entry => entry.status !== 'cached' && entry.status !== 'fetched')
  if (textFailed !== undefined) {
    skip(
      `the pinned ${textFailed.file} is not cached and ${textFailed.status === 'offline-missing' ? 'the run is offline' : 'the download could not complete'}`
      + ` (got ${textFailed.got} of ${textFailed.bytes} bytes)`,
    )
  }
  const visionFetches = PINNED_MEDIA.slice(0, 3).map(pinned => verifyOrFetch(pinned, pinned.file))
  const visionReady = visionFetches.every(entry => entry.status === 'cached' || entry.status === 'fetched')
  // --no-audio: no fetch, the group is recorded as a measured partial (MOD-02's
  // group boundary means the text+vision qualification does not need it).
  const audioFetches = NO_AUDIO
    ? PINNED_MEDIA.slice(3).map(pinned => ({
        ...pinned,
        status: 'not-run',
        got: existsSync(join(CACHE_DIR, ...pinned.file.split('/')))
          ? statSync(join(CACHE_DIR, ...pinned.file.split('/'))).size
          : 0,
      }))
    : PINNED_MEDIA.slice(3).map(pinned => verifyOrFetch(pinned, pinned.file))
  const audioReady = audioFetches.every(entry => entry.status === 'cached' || entry.status === 'fetched')
  const fetches = [...textFetches, ...visionFetches, ...audioFetches]

  const { instance, provider } = await buildProvider()
  const preparedGroups = [
    'text-backbone',
    ...visionReady ? ['vision-encoder'] : [],
    ...audioReady ? ['audio-encoder'] : [],
  ]
  const assets = {
    get: (assetId) => (
      preparedGroups.includes(assetId) ? { path: CACHE_DIR, digest: `sha256:${REVISION}` } : undefined
    ),
    assetIds: preparedGroups,
  }

  // COLD load, timed.
  const coldStarted = Date.now()
  await provider.load({ assets, signal: new AbortController().signal })
  const coldLoadMs = Date.now() - coldStarted

  // WARM load in a fresh process: the weights are already verified on disk.
  const warm = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--warm-probe'], { encoding: 'utf8', windowsHide: true })
  const warmLine = (warm.stdout ?? '').trim().split(/\r?\n/).find(line => line.startsWith('WARM-LOAD '))
  const warmLoadMs = warmLine === undefined
    ? null
    : JSON.parse(warmLine.slice('WARM-LOAD '.length)).loadMs

  const IDENTICAL = 'Embedding models turn text into vectors for search and comparison.'
  const UNRELATED = 'The spacecraft recorded radio emissions from the outer planet magnetosphere.'
  const similarity = async (left, right) => {
    const started = Date.now()
    const value = await provider.invoke({
      implementationId: 'embeddinggemma2-similarity',
      input: { left: { id: 'l', parts: [{ kind: 'text', text: left }] }, right: { id: 'r', parts: [{ kind: 'text', text: right }] } },
      context: invocationContext(),
    })
    return { ...value, invokeMs: Date.now() - started }
  }

  const identical = await similarity(IDENTICAL, IDENTICAL)
  const unrelated = await similarity(IDENTICAL, UNRELATED)
  const assertions = [
    { id: 'identical-pair', pass: identical.score > 0.99, detail: `cosine ${identical.score.toFixed(4)}` },
    { id: 'unrelated-pair-lower', pass: unrelated.score < identical.score - 0.15, detail: `cosine ${unrelated.score.toFixed(4)} vs ${identical.score.toFixed(4)}` },
  ]

  // MOD-04: every documented reduction width, with a dimension + unit-norm check each.
  const reductions = []
  for (const width of [512, 256, 128]) {
    const started = Date.now()
    const value = await provider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: { items: [{ id: 'r', parts: [{ kind: 'text', text: IDENTICAL }] }], purpose: 'similarity', role: 'symmetric', dimensions: width },
      context: invocationContext(),
    })
    const vector = value.vectors[0]
    const norm = Math.sqrt((vector?.values ?? []).reduce((acc, entry) => acc + entry * entry, 0))
    const pass = vector?.values.length === width && vector.dimensions === width && Math.abs(norm - 1) < 1e-4
    reductions.push({ width, pass, dimensions: vector?.values.length ?? 0, norm, invokeMs: Date.now() - started })
    assertions.push({ id: `reduction-${width}`, pass, detail: `length ${vector?.values.length ?? 0}, norm ${norm.toFixed(5)}` })
  }

  // MOD-06/07 media halves: GENERATED synthetic fixtures (solid + checkerboard
  // PNGs; two sine WAVs) through the bounded Node decoders and the pinned
  // vision/audio encoders into the SHARED 768-dimensional space. The fixtures
  // are written beside the cache and their digests recorded, so a re-run can
  // reproduce the exact bytes. Each case runs ONLY when its group's artifacts
  // verified — a missing group is recorded as not-run, never faked.
  const fixturesDir = join(CACHE_DIR, 'fixtures')
  mkdirSync(fixturesDir, { recursive: true })
  const fixtures = {
    solid: { name: 'solid-red.png', bytes: generatedPng('solid', 200, 0, 80) },
    checker: { name: 'checker-green.png', bytes: generatedPng('checker', 40, 220, 60) },
    sine440: { name: 'sine-440.wav', bytes: generatedWav(440) },
    sine880: { name: 'sine-880.wav', bytes: generatedWav(880) },
  }
  for (const fixture of Object.values(fixtures)) {
    writeFileSync(join(fixturesDir, fixture.name), fixture.bytes)
    fixture.sha256 = createHash('sha256').update(fixture.bytes).digest('hex')
  }
  const mediaSimilarity = async (left, right) => {
    const started = Date.now()
    const value = await provider.invoke({
      implementationId: 'embeddinggemma2-similarity',
      input: {
        left: { id: 'l', parts: [{ kind: left.kind, path: join(fixturesDir, left.name) }] },
        right: { id: 'r', parts: [{ kind: right.kind, path: join(fixturesDir, right.name) }] },
      },
      context: invocationContext(),
    })
    return { ...value, invokeMs: Date.now() - started }
  }

  // The media vectors must be 768-wide, finite and unit-norm (the shared space,
  // MOD-03/04), and the identical/different margins must hold IN the real space.
  const mediaEmbed = async (kind, name) => {
    const started = Date.now()
    const value = await provider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: { items: [{ id: 'm', parts: [{ kind, path: join(fixturesDir, name) }] }], purpose: 'similarity', role: 'symmetric' },
      context: invocationContext(),
    })
    const vector = value.vectors[0]
    const values = vector?.values ?? []
    const norm = Math.sqrt(values.reduce((acc, entry) => acc + entry * entry, 0))
    const finite = values.every(Number.isFinite)
    return { vector, norm, finite, processing: value.processing[0], invokeMs: Date.now() - started }
  }

  const media = { image: undefined, audio: undefined, video: undefined, crossModal: undefined }
  if (visionReady) {
    const imageIdentical = await mediaSimilarity({ kind: 'image', name: fixtures.solid.name }, { kind: 'image', name: fixtures.solid.name })
    const imageDifferent = await mediaSimilarity({ kind: 'image', name: fixtures.solid.name }, { kind: 'image', name: fixtures.checker.name })
    const imageEmbed = await mediaEmbed('image', fixtures.solid.name)
    media.image = { fixtures: { solid: fixtures.solid.sha256, checker: fixtures.checker.sha256 }, identical: imageIdentical, different: imageDifferent, embed: { values: imageEmbed.vector, processing: imageEmbed.processing, invokeMs: imageEmbed.invokeMs } }
    assertions.push(
      { id: 'image-identical', pass: imageIdentical.score > 0.99, detail: `cosine ${imageIdentical.score.toFixed(4)} (${imageIdentical.invokeMs} ms)` },
      { id: 'image-different-lower', pass: imageDifferent.score < imageIdentical.score - 0.1, detail: `cosine ${imageDifferent.score.toFixed(4)} vs ${imageIdentical.score.toFixed(4)}` },
      { id: 'image-vector', pass: imageEmbed.vector?.values.length === 768 && imageEmbed.finite && Math.abs(imageEmbed.norm - 1) < 1e-4, detail: `length ${imageEmbed.vector?.values.length ?? 0}, finite=${imageEmbed.finite}, norm ${imageEmbed.norm.toFixed(5)}` },
    )
  }
  if (audioReady) {
    // The synthesized SPEECH utterances (the same System.Speech pair qualify-voz
    // uses) are the genuinely different CONTENT pair: two pure sine tones cluster
    // in this space (440 vs 880 Hz measured 0.96), which the model's audio encoder
    // makes honest — so the different-content margin is judged on speech, not tones.
    const speech = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(SCRIPT_DIR, 'synthesize-voz-utterances.ps1'), '-OutDir', fixturesDir,
    ], { encoding: 'utf8', windowsHide: true })
    if (speech.status !== 0) {
      throw new Error(`utterance synthesis for the audio case failed: ${speech.stderr ?? speech.stdout ?? 'unknown'}`)
    }
    const voices = JSON.parse(readFileSync(join(fixturesDir, 'voices.json'), 'utf8').replace(/^\uFEFF/, ''))
    const germanWav = readFileSync(join(fixturesDir, 'german.wav'))
    const englishWav = readFileSync(join(fixturesDir, 'english.wav'))
    const audioIdentical = await mediaSimilarity({ kind: 'audio', name: fixtures.sine440.name }, { kind: 'audio', name: fixtures.sine440.name })
    const audioDifferent = await mediaSimilarity({ kind: 'audio', name: 'german.wav' }, { kind: 'audio', name: 'english.wav' })
    const audioEmbed = await mediaEmbed('audio', fixtures.sine440.name)
    const tonePair = await mediaSimilarity({ kind: 'audio', name: fixtures.sine440.name }, { kind: 'audio', name: fixtures.sine880.name })
    media.audio = {
      fixtures: {
        sine440: fixtures.sine440.sha256,
        sine880: fixtures.sine880.sha256,
        german: createHash('sha256').update(germanWav).digest('hex'),
        english: createHash('sha256').update(englishWav).digest('hex'),
      },
      voices: { german: voices.german.voice, english: voices.english.voice },
      identical: audioIdentical,
      different: audioDifferent,
      tonePair,
      embed: { values: audioEmbed.vector, processing: audioEmbed.processing, invokeMs: audioEmbed.invokeMs },
    }
    assertions.push(
      { id: 'audio-identical', pass: audioIdentical.score > 0.99, detail: `cosine ${audioIdentical.score.toFixed(4)} (${audioIdentical.invokeMs} ms)` },
      { id: 'audio-different-lower', pass: audioDifferent.score < audioIdentical.score - 0.1, detail: `german-vs-english cosine ${audioDifferent.score.toFixed(4)} vs ${audioIdentical.score.toFixed(4)}` },
      { id: 'audio-vector', pass: audioEmbed.vector?.values.length === 768 && audioEmbed.finite && Math.abs(audioEmbed.norm - 1) < 1e-4, detail: `length ${audioEmbed.vector?.values.length ?? 0}, finite=${audioEmbed.finite}, norm ${audioEmbed.norm.toFixed(5)}` },
    )
  }
  if (visionReady && audioReady) {
    media.crossModal = { imageVsAudio: await mediaSimilarity({ kind: 'image', name: fixtures.solid.name }, { kind: 'audio', name: fixtures.sine440.name }) }
  }

  /**
   * VIDEO (H4): the bounded sampler feeds the FUSED video path — per-frame
   * BGR24 decode, the pinned aspect-ratio-preserving resize to the 1260-patch
   * (140-token) video grid, the per-frame vision-encoder runs and the fused
   * video_features scatter — and a REAL 768-d embedding must come back, finite
   * and unit-normalized, with the honest sampled-frame timestamps.
   */
  const aviPath = join(fixturesDir, 'video.avi')
  writeFileSync(aviPath, generatedAvi(FRAMES_VIDEO))
  const { sampleVideoFrames } = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'extension-embeddinggemma', 'lib', 'media.js')).href)
  const video = await sampleVideoFrames(aviPath)
  media.video = {
    fixture: {
      digest: createHash('sha256').update(readFileSync(aviPath)).digest('hex'),
      layout: 'RIFF/AVI, uncompressed DIB (BGR24) frames — the one container+codec the sampler implements',
    },
    sampling: {
      width: video.width,
      height: video.height,
      frames: video.frames,
      declaredFps: video.declaredFps,
      sampleTimestamps: video.sampleTimestamps,
      sampleDigests: video.samples.map(sample => createHash('sha256').update(sample.bytes).digest('hex')),
    },
    embedding: visionReady
      ? await (async () => {
        const started = Date.now()
        const value = await mediaEmbed('video', 'video.avi')
        const vector = value.vector
        const values = vector?.values ?? []
        const norm = Math.sqrt(values.reduce((acc, entry) => acc + entry * entry, 0))
        const finite = values.every(Number.isFinite)
        return {
          dimensions: vector?.dimensions ?? 0,
          length: values.length,
          finite,
          norm,
          processing: value.processing,
          invokeMs: Date.now() - started,
        }
      })()
      : { skipped: true, reason: 'the vision artifacts are absent on this host; the fused video embedding cannot run' },
  }
  assertions.push(
    { id: 'video-sampler', pass: video.width === 32 && video.height === 24 && video.frames === 4 && video.samples.length >= 1 && video.samples.length <= 32, detail: `sampled ${video.samples.length}/${video.frames} frames of ${video.width}x${video.height} at ${video.declaredFps} fps (timestamps ${JSON.stringify(video.sampleTimestamps)})` },
    {
      id: 'video-embedding',
      pass: visionReady
        && media.video.embedding.skipped !== true
        && media.video.embedding.length === 768
        && media.video.embedding.finite
        && Math.abs(media.video.embedding.norm - 1) < 1e-4,
      detail: visionReady
        ? `length ${media.video.embedding.length}, finite=${media.video.embedding.finite}, norm ${media.video.embedding.norm?.toFixed(5)} (${media.video.embedding.invokeMs} ms)`
        : 'SKIPPED-artifacts-missing: the vision artifacts are absent, so the fused video embedding cannot run',
    },
  )

  /**
   * THE THREE DERIVED TOOLS (MOD-11/12/13), measured over the REAL space with
   * the shared encoders already loaded — no extra model instances.
   */
  const derived = { classify: null, deduplicate: null, moments: null }
  if (audioReady) {
    // semantic_classify: the item's own text vs an unrelated description selects;
    // an impossible margin (1.5) always abstains (MOD-11 honesty).
    const classifySelected = await provider.invoke({
      implementationId: 'embeddinggemma2-classify',
      input: {
        item: { id: 'c-item', parts: [{ kind: 'text', text: IDENTICAL }] },
        labels: [
          { id: 'match', description: IDENTICAL },
          { id: 'other', description: UNRELATED },
        ],
        min_score: 0.5,
        min_margin: 0.1,
      },
      context: invocationContext(),
    })
    const classifyAbstained = await provider.invoke({
      implementationId: 'embeddinggemma2-classify',
      input: {
        item: { id: 'c-item', parts: [{ kind: 'text', text: IDENTICAL }] },
        labels: [
          { id: 'match', description: IDENTICAL },
          { id: 'other', description: UNRELATED },
        ],
        min_score: 0,
        min_margin: 1.5,
      },
      context: invocationContext(),
    })

    // semantic_deduplicate: identical pair + an unrelated item, high threshold.
    const dedup = await provider.invoke({
      implementationId: 'embeddinggemma2-deduplicate',
      input: {
        items: [
          { id: 'a', parts: [{ kind: 'text', text: IDENTICAL }] },
          { id: 'b', parts: [{ kind: 'text', text: IDENTICAL }] },
          { id: 'c', parts: [{ kind: 'text', text: UNRELATED }] },
        ],
        threshold: 0.9,
      },
      context: invocationContext(),
    })

    // media_find_moments: a two-tone WAV (2 s at 440 Hz, then 2 s at 880 Hz);
    // the query is the 880 Hz clip itself, so the 880 Hz windows must outscore
    // the 440 Hz ones. 1 s windows at a 1 s stride over exactly 4 s: four
    // windows, no clipped tail (the source is an exact multiple).
    const twoTone = generatedWavSegments([{ hz: 440, seconds: 2 }, { hz: 880, seconds: 2 }])
    writeFileSync(join(fixturesDir, 'twotone.wav'), twoTone)
    const moments = await provider.invoke({
      implementationId: 'embeddinggemma2-moments',
      input: {
        query: { id: 'q', parts: [{ kind: 'audio', path: join(fixturesDir, 'sine-880.wav') }] },
        media: { kind: 'audio', path: join(fixturesDir, 'twotone.wav') },
        windowSeconds: 1,
        strideSeconds: 1,
      },
      context: invocationContext(),
    })
    // The FINAL-WINDOW CLIP case: a 3.5 s source yields windows [0,1],[1,2],[2,3]
    // plus the clipped final [2.5,3.5] — five windows, the final included once.
    const clippedTone = generatedWavSegments([{ hz: 440, seconds: 2 }, { hz: 880, seconds: 1.5 }])
    writeFileSync(join(fixturesDir, 'clipped.wav'), clippedTone)
    const momentsClipped = await provider.invoke({
      implementationId: 'embeddinggemma2-moments',
      input: {
        query: { id: 'q', parts: [{ kind: 'audio', path: join(fixturesDir, 'sine-880.wav') }] },
        media: { kind: 'audio', path: join(fixturesDir, 'clipped.wav') },
        windowSeconds: 1,
        strideSeconds: 1,
      },
      context: invocationContext(),
    })

    /**
     * media_find_moments VIDEO (MOD-13): a two-segment AVI — 2 s of red frames
     * then 2 s of blue frames at 2 fps — and a query that is a short VIDEO of
     * the blue pattern itself. 1 s windows at a 1 s stride: four windows; the
     * blue half (windows at 2 s and 3 s) must outscore the red half, proving
     * the per-window scoring rides the REAL fused video pipeline rather than
     * image-grid synthesis.
     */
    let momentsVideo = null
    if (visionReady) {
      const blueFrame = { red: 20, green: 30, blue: 240 }
      const redFrame = { red: 240, green: 30, blue: 20 }
      const twoSegment = generatedAvi([redFrame, redFrame, redFrame, redFrame, blueFrame, blueFrame, blueFrame, blueFrame])
      writeFileSync(join(fixturesDir, 'twosegment.avi'), twoSegment)
      const blueClip = generatedAvi([blueFrame, blueFrame])
      writeFileSync(join(fixturesDir, 'blueclip.avi'), blueClip)
      momentsVideo = await provider.invoke({
        implementationId: 'embeddinggemma2-moments',
        input: {
          query: { id: 'qv', parts: [{ kind: 'video', path: join(fixturesDir, 'blueclip.avi') }] },
          media: { kind: 'video', path: join(fixturesDir, 'twosegment.avi') },
          windowSeconds: 1,
          strideSeconds: 1,
        },
        context: invocationContext(),
      })
    }

    derived.classify = {
      selected: classifySelected,
      abstained: classifyAbstained,
    }
    derived.deduplicate = dedup
    derived.moments = { exact: moments, clipped: momentsClipped, ...momentsVideo === null ? {} : { video: momentsVideo } }
    assertions.push(
      {
        id: 'classify-selected',
        pass: classifySelected.status === 'selected' && classifySelected.label === 'match' && classifySelected.calibrated === false
          && classifySelected.scores.every(entry => typeof entry.score === 'number'),
        detail: `status ${classifySelected.status} label ${classifySelected.label ?? 'none'} best ${classifySelected.scores[0]?.score.toFixed(4)}`,
      },
      {
        id: 'classify-abstained',
        pass: classifyAbstained.status === 'abstained' && classifyAbstained.label === undefined,
        detail: `status ${classifyAbstained.status} (an impossible 1.5 margin must abstain, never fabricate a decision)`,
      },
      {
        id: 'deduplicate-groups',
        pass: dedup.algorithm === 'greedy_representative_cosine_v1'
          && dedup.groups.length === 2
          && dedup.groups.some(group => group.representativeId === 'a' && group.members.length === 2)
          && dedup.groups.some(group => group.representativeId === 'c' && group.members.length === 1),
        detail: `${dedup.groups.length} groups: ${dedup.groups.map(group => `${group.representativeId}(${group.members.length})`).join(', ')}`,
      },
      {
        id: 'moments-window-match',
        pass: moments.windowsEvaluated === 4
          && moments.sampledFrameTimestampsSeconds.length === 0
          && moments.matches.length > 0
          && moments.matches[0].startSeconds >= 1.9,
        detail: `evaluated ${moments.windowsEvaluated}, top at ${moments.matches[0]?.startSeconds?.toFixed(2)} s with score ${moments.matches[0]?.score?.toFixed(4)}`,
      },
      {
        id: 'moments-final-window-clip',
        pass: momentsClipped.windowsEvaluated === 4
          && momentsClipped.matches.every(match => match.endSeconds <= 3.5)
          && momentsClipped.matches.some(match => Math.abs(match.endSeconds - 3.5) < 1e-6),
        detail: `evaluated ${momentsClipped.windowsEvaluated} over a 3.5 s source; the clipped final window (2.5-3.5 s) is among the matches`,
      },
      {
        id: 'moments-video-windows',
        pass: momentsVideo !== null
          && momentsVideo.windowsEvaluated === 4
          && momentsVideo.matches.length > 0
          && momentsVideo.matches[0].startSeconds >= 1.9
          && momentsVideo.sampledFrameTimestampsSeconds.length > 0,
        detail: momentsVideo === null
          ? 'SKIPPED-vision-artifacts-missing: the vision group is absent, so per-window video scoring cannot run'
          : `evaluated ${momentsVideo.windowsEvaluated} video windows; top at ${momentsVideo.matches[0]?.startSeconds?.toFixed(2)} s (the blue half) with score ${momentsVideo.matches[0]?.score?.toFixed(4)}; ${momentsVideo.sampledFrameTimestampsSeconds.length} frame timestamps recorded`,
      },
    )
  }

  const failures = assertions.filter(entry => !entry.pass)
  const record = {
    model: {
      id: 'embeddinggemma-2',
      identity: 'google/embeddinggemma-2',
      conversion: REPO,
      revision: REVISION,
      quantizationProfile: 'unquantized (fp32 model.onnx, as shipped)',
      engine: 'onnxruntime-node (native CPU execution provider) + @huggingface/transformers (GemmaTokenizer only)',
      platform: { os: process.platform, arch: process.arch, accelerator: 'cpu' },
      extension: '@try-works/extension-embeddinggemma',
      extensionEntry: EXTENSION_LIB,
      cache: CACHE_DIR,
      space: 'embeddinggemma-2/text/daa72c512439-9fd452bfc691',
    },
    files: fetches.map(entry => ({ file: entry.file, bytes: entry.bytes, sha256: entry.sha256, status: entry.status })),
    groups: {
      text: 'measured',
      vision: visionReady ? 'measured' : 'artifacts-missing',
      audio: audioReady
        ? 'measured'
        : `partial: audio_encoder.onnx_data is incomplete on this host (the segment fetcher recorded ${'the measured segments'}; the digest is NOT verified)`,
      video: visionReady ? 'measured: the fused video path embeds the generated AVI fixture (sampler + per-frame video grid + fused scatter)' : 'sampler-measured, embedding-artifacts-missing',
    },
    load: { coldLoadMs, warmLoadMs },
    measurements: {
      identicalPair: identical,
      unrelatedPair: unrelated,
      reductions,
      ...media.image === undefined ? {} : { imagePair: media.image },
      ...media.audio === undefined ? {} : { audioPair: media.audio },
      ...media.video === undefined ? {} : { videoSampling: media.video },
      ...media.crossModal === undefined ? {} : { crossModal: media.crossModal },
      ...derived.classify === null ? {} : { derivedTools: derived },
    },
    assertions,
    provenance: {
      recordings: 'none: the media fixtures are GENERATED (solid/checkerboard PNGs and sine WAVs, digests recorded); no real media or speaker corpus is involved',
      reconstructions: [
        'The vision soft-token prompt (<|image> + 280 x <|image|> + <image|>) and the axial pixel_position_ids (integer [row, col] patch indices) are RECONSTRUCTIONS from the pinned graph signature and config ids: they are falsifiable only by the shared-space sanity margins, not by an independent processor trace. CONFORMANCE IS NOT CLAIMED: comparing against the upstream processor or a golden fixture remains an open MOD-06 remainder.',
        'The mel convention is log(max(power + 1, melFloor)); the pinned preprocessor_config names the feature extractor parameters but not the log convention. CONFORMANCE IS NOT CLAIMED for the same reason.',
      ],
      remainders: [
        'VIDEO WINDOW SCORING in media_find_moments: the fused video EMBEDDING is implemented and measured (H4); per-window video scoring in media_find_moments remains the recorded remainder (the tool refuses video media with that precise reason).',
        'A real media corpus qualification (cross-modal retrieval with human-checked relevance) is not performed.',
        'Upstream-processor comparison or a golden fixture for the media preprocessing (MOD-06 conformance).',
        ...audioReady ? [] : ['The AUDIO clauses did not run: audio_encoder.onnx_data could not be verified on this host.'],
        ...visionReady ? [] : ['The IMAGE clauses did not run: the vision artifacts could not be verified on this host.'],
      ],
      scope: `TEXT${visionReady ? ' + IMAGE' : ''}${audioReady ? ' + AUDIO' : ''} + VIDEO-SAMPLER. The fused model${visionReady ? ', the vision encoder' : ''}${audioReady ? ' and the audio encoder' : ''} over the pinned groups that verified, driven through the extension's bounded Node decoders; generated fixtures only.`,
    },
    verdict: failures.length === 0 ? 'pass' : 'fail',
    recordedAt: new Date().toISOString(),
  }

  if (!SMOKE) {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'embeddinggemma.json'), JSON.stringify(record, null, 2) + '\n')
  } else {
    process.stdout.write(`SMOKE ${record.verdict}: cold ${coldLoadMs} ms, warm ${warmLoadMs ?? 'n/a'} ms\n`)
  }
  for (const assertion of assertions) {
    process.stdout.write(`[${assertion.id}] ${assertion.pass ? 'PASS' : 'FAIL'}: ${assertion.detail}\n`)
  }
  await instance.dispose('qualification end')
  if (failures.length > 0) {
    process.stderr.write(`QUALIFICATION FAILED: ${failures.map(entry => entry.id).join(', ')}\n`)
    process.exit(1)
  }
  process.exit(0)
}

if (args.includes('--warm-probe')) {
  // A fresh process: the verified weights sit on disk; measure the load alone.
  const { provider } = await buildProvider()
  const started = Date.now()
  await provider.load({
    assets: { get: id => (id === 'text-backbone' ? { path: CACHE_DIR, digest: `sha256:${REVISION}` } : undefined), assetIds: ['text-backbone'] },
    signal: new AbortController().signal,
  })
  process.stdout.write(`WARM-LOAD ${JSON.stringify({ loadMs: Date.now() - started })}\n`)
  process.exit(0)
}

void main()
