/**
 * The REAL EmbeddingGemma text backbone, pinned and qualified (MOD-01..MOD-04, text half).
 *
 * These tests drive the wired inference path over the PINNED artifacts — the exact five files
 * whose digests and revision are recorded in models.lock.json — cached under
 * `~/.cache/embeddinggemma-2/onnx-community/<revision>` (or `EMBEDDINGGEMMA_CACHE_DIR`).
 * Where the artifacts do not exist on the machine, every test SKIPS WITH THE REASON rather
 * than faking a pass: run `npm run qualify:embeddinggemma` once to fetch them.
 *
 * What is pinned here:
 * - load() with ONLY the text-backbone group succeeds and the inspection then reports
 *   `ready` — the MOD-02 group boundary made executable (no vision/audio asset is required,
 *   read, or fetched; the source of inference.ts has no fetch call at all);
 * - a REAL embedding is 768-dimensional, unit-norm, and the reduction produces the
 *   documented widths (768/512/256/128) with L2 renormalization (MOD-04);
 * - sentence-pair sanity: an identical pair scores ≈ 1.0, an unrelated pair measurably
 *   lower, in the REAL space (MODEL-05's EmbeddingGemma record);
 * - all three tools complete against the real engine with the contract payload shapes.
 *
 * Requirement links: MOD-01, MOD-02, MOD-03, MOD-04, MODEL-05, MOD-09, MOD-10.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

import { activateExtension, type ExtensionContextV1, type InvocationContextV1 } from '@try-works/tool-mode-extension-sdk'
import extension from '../src/index.ts'

/** The pinned conversion revision (models.lock.json). */
const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'

/** The canonical backbone cache directory. */
const CACHE_DIR = process.env.EMBEDDINGGEMMA_CACHE_DIR
  ?? join(homedir(), '.cache', 'embeddinggemma-2', 'onnx-community', REVISION)

const BACKBONE_PRESENT = existsSync(join(CACHE_DIR, 'onnx', 'model.onnx'))
  && existsSync(join(CACHE_DIR, 'onnx', 'model.onnx_data'))
  && existsSync(join(CACHE_DIR, 'tokenizer.json'))

const SKIP_REASON = BACKBONE_PRESENT
  ? undefined
  : `the pinned EmbeddingGemma text backbone is not cached under ${CACHE_DIR}; run npm run qualify:embeddinggemma once (it downloads and verifies the pinned files), or set EMBEDDINGGEMMA_CACHE_DIR`

/** A host-issued context, with nothing but what EXT-18 allows. */
function context(): ExtensionContextV1 {
  return {
    extensionId: '@try-works/extension-embeddinggemma',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** The call-scoped context, with the caller's own signal. */
function invocation(signal: AbortSignal = new AbortController().signal): InvocationContextV1 {
  return {
    invocationId: 'real-path-test',
    signal,
    limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
    resolvePath: candidate => candidate,
  }
}

const IDENTICAL = 'Embedding models turn text into vectors for search and comparison.'
const UNRELATED = 'The spacecraft recorded radio emissions from the outer planet magnetosphere.'

/** The prepared asset map: ONLY the text backbone, exactly as MOD-02 specifies. */
const assets = {
  get: (assetId: string) => (
    assetId === 'text-backbone' ? { path: CACHE_DIR, digest: `sha256:${REVISION}` } : undefined
  ),
  assetIds: ['text-backbone'],
}

describe('MOD-01/MOD-02/MOD-04 — the REAL text backbone loads alone and embeds', { skip: SKIP_REASON }, () => {
  it('loads with ONLY the text-backbone group and then reports ready', async () => {
    const instance = await activateExtension(extension, context())
    const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await provider.load({ assets, signal: new AbortController().signal })
    const inspection = await provider.inspect(new AbortController().signal)
    assert.equal(inspection.readiness, 'ready', 'a loaded deployment must report ready')
    assert.ok(inspection.features.includes('text-embeddings'))
    await instance.dispose('test end')
  })

  it('produces a 768-dimensional unit-norm embedding and reduces to every documented width (MOD-04)', async () => {
    const instance = await activateExtension(extension, context())
    const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await provider.load({ assets, signal: new AbortController().signal })
    const result = await provider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: { items: [{ id: 'item-1', parts: [{ kind: 'text', text: IDENTICAL }] }], purpose: 'similarity', role: 'symmetric', dimensions: 768 },
      context: invocation(),
    }) as { vectors: Array<Record<string, unknown>> }
    const vector = result.vectors[0] as { values: number[]; dimensions: number; normalized: boolean; embeddingSpaceId: string }
    assert.equal(vector.dimensions, 768)
    assert.equal(vector.values.length, 768)
    assert.equal(vector.normalized, true)
    assert.match(String(vector.embeddingSpaceId), /^embeddinggemma-2\/text\//)
    const norm = Math.sqrt(vector.values.reduce((acc, value) => acc + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-4, `the embedding must be unit-norm, saw ${norm}`)

    for (const width of [512, 256, 128]) {
      const reduced = await provider.invoke({
        implementationId: 'embeddinggemma2-onnx',
        input: { items: [{ id: 'r', parts: [{ kind: 'text', text: IDENTICAL }] }], purpose: 'similarity', role: 'symmetric', dimensions: width },
        context: invocation(),
      }) as { vectors: Array<{ values: number[] }> }
      const values = reduced.vectors[0]?.values as number[]
      assert.equal(values.length, width, `the ${width}-dimension reduction must return exactly ${width} values`)
      const reducedNorm = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0))
      assert.ok(Math.abs(reducedNorm - 1) < 1e-4, 'the reduction must renormalize to unit norm (MOD-04)')
    }
    await instance.dispose('test end')
  })

  it('sentence-pair sanity in the REAL space: identical ≈ 1.0, unrelated measurably lower (MODEL-05)', async () => {
    const instance = await activateExtension(extension, context())
    const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await provider.load({ assets, signal: new AbortController().signal })
    const identical = await provider.invoke({
      implementationId: 'embeddinggemma2-similarity',
      input: {
        left: { id: 'l', parts: [{ kind: 'text', text: IDENTICAL }] },
        right: { id: 'r', parts: [{ kind: 'text', text: IDENTICAL }] },
      },
      context: invocation(),
    }) as { score: number; scoreKind: string; embeddingSpaceId: string }
    assert.equal(identical.scoreKind, 'cosine_similarity')
    assert.ok(identical.score > 0.99, `an identical pair must score ≈ 1.0, saw ${identical.score}`)

    const unrelated = await provider.invoke({
      implementationId: 'embeddinggemma2-similarity',
      input: {
        left: { id: 'l', parts: [{ kind: 'text', text: IDENTICAL }] },
        right: { id: 'r', parts: [{ kind: 'text', text: UNRELATED }] },
      },
      context: invocation(),
    }) as { score: number }
    assert.ok(unrelated.score < identical.score - 0.15, `an unrelated pair must score measurably lower: ${unrelated.score} vs ${identical.score}`)
    await instance.dispose('test end')
  })

  it('semantic_rank orders the real candidates and preserves their ids (MOD-10)', async () => {
    const instance = await activateExtension(extension, context())
    const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await provider.load({ assets, signal: new AbortController().signal })
    const ranked = await provider.invoke({
      implementationId: 'embeddinggemma2-rank',
      input: {
        query: { id: 'q', parts: [{ kind: 'text', text: IDENTICAL }] },
        candidates: [
          { id: 'unrelated', parts: [{ kind: 'text', text: UNRELATED }] },
          { id: 'near-duplicate', parts: [{ kind: 'text', text: IDENTICAL + ' Vectors power semantic search.' }] },
        ],
        top_k: 2,
      },
      context: invocation(),
    }) as { results: Array<{ id: string; score: number }>; scoreKind: string }
    assert.equal(ranked.scoreKind, 'cosine_similarity')
    assert.equal(ranked.results.length, 2)
    assert.deepEqual(
      ranked.results.map(entry => entry.id),
      ['near-duplicate', 'unrelated'],
      'the near-duplicate candidate must outrank the unrelated one, with the caller ids preserved',
    )
    assert.ok(ranked.results[0]!.score > ranked.results[1]!.score)
    await instance.dispose('test end')
  })
})

// ── The media half (MOD-06/07) ────────────────────────────────────────────────

// A PARTIAL download (mid-fetch) must not read as present: the pinned byte
// sizes decide, so a still-growing audio_encoder.onnx_data skips instead of
// racing the downloader's file lock.
function pinnedSize(path: string, bytes: number): boolean {
  try {
    return existsSync(path) && statSync(path).size === bytes
  } catch {
    return false
  }
}

const MEDIA_PRESENT = pinnedSize(join(CACHE_DIR, 'onnx', 'vision_encoder.onnx_data'), 671026176)
  && pinnedSize(join(CACHE_DIR, 'onnx', 'audio_encoder.onnx_data'), 1172750848)

const MEDIA_SKIP_REASON = MEDIA_PRESENT
  ? undefined
  : `the pinned vision/audio encoder weights are not cached at their pinned sizes under ${CACHE_DIR}; run npm run qualify:embeddinggemma once`

/** PNG CRC-32 (for the generated fixture below). */
function pngCrc(type: string, data: Buffer): Buffer {
  const table: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table.push(c >>> 0)
  }
  const bytes = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  const out = Buffer.alloc(4)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return out
}

/** A minimal truecolor PNG chunk writer. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, pngCrc(type, data)])
}

/** A generated 96x96 solid-color PNG. */
function solidPng(red: number, green: number, blue: number): Buffer {
  const width = 96
  const height = 96
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    scanlines.writeUInt8(0, y * (1 + width * 3))
    for (let x = 0; x < width; x += 1) {
      const offset = y * (1 + width * 3) + 1 + x * 3
      scanlines.writeUInt8(red, offset)
      scanlines.writeUInt8(green, offset + 1)
      scanlines.writeUInt8(blue, offset + 2)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A generated 96x96 checkerboard PNG (8x8 blocks of the given color vs black).
 *
 * The different-IMAGE fixture: two UNIFORM solids cluster in this space (the
 * qualification measured ~0.97-0.99 for solid-vs-solid), while a checkerboard's
 * surviving grid structure separates from a solid measurably (0.8843) — so the
 * margin is judged on the pattern, not on two shades.
 */
function checkerPng(red: number, green: number, blue: number): Buffer {
  const width = 96
  const height = 96
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    scanlines.writeUInt8(0, y * (1 + width * 3))
    for (let x = 0; x < width; x += 1) {
      const dark = ((x >> 3) + (y >> 3)) % 2 === 1
      const offset = y * (1 + width * 3) + 1 + x * 3
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

/**
 * A minimal uncompressed-DIB AVI fixture (the one container+codec the bounded
 * sampler implements): solid BGR24 frames at 2 fps, 48x48 so the video grid's
 * side multiple (48) holds exactly.
 */
function miniAvi(frames: ReadonlyArray<{ red: number; green: number; blue: number }>): Buffer {
  const width = 48
  const height = 48
  const fps = 2
  const stride = Math.ceil((width * 3) / 4) * 4
  const frameBytes = stride * height
  const chunk = (id: string, payload: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'ascii')
    head.writeUInt32LE(payload.byteLength, 4)
    return Buffer.concat([head, payload, payload.byteLength % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const movi: Buffer[] = []
  for (const frame of frames) {
    const rows = Buffer.alloc(frameBytes)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = y * stride + x * 3
        rows.writeUInt8(frame.blue, base)
        rows.writeUInt8(frame.green, base + 1)
        rows.writeUInt8(frame.red, base + 2)
      }
    }
    movi.push(chunk('00db', rows))
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
  const hdrl = chunk('LIST', Buffer.concat([
    Buffer.from('hdrl', 'ascii'),
    chunk('avih', avih),
    chunk('LIST', Buffer.concat([Buffer.from('strl', 'ascii'), chunk('strh', strh), chunk('strf', strf)])),
  ]))
  const moviList = chunk('LIST', Buffer.concat([Buffer.from('movi', 'ascii'), ...movi]))
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('AVI ', 'ascii'), hdrl, moviList])
}

/** A generated 16 kHz PCM16 mono WAV holding one sine. */
function sineWav(frequency: number): Buffer {
  const rate = 16000
  const frames = Math.floor(rate * 1.2)
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

/** A prepared asset map with all THREE groups, per MOD-02. */
function mediaAssets(): { get(assetId: string): { path: string; digest: string } | undefined; assetIds: string[] } {
  return {
    get: (assetId: string) => (
      assetId === 'text-backbone' || assetId === 'vision-encoder' || assetId === 'audio-encoder'
        ? { path: CACHE_DIR, digest: `sha256:${REVISION}` }
        : undefined
    ),
    assetIds: ['text-backbone', 'vision-encoder', 'audio-encoder'],
  }
}

describe('MOD-06/07 — the REAL vision and audio encoders embed through the bounded decoders', { skip: MEDIA_SKIP_REASON }, () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'eg2-media-'))

  after(() => rmSync(fixtureDir, { recursive: true, force: true }))

  it('embeds a generated image and a generated WAV into 768-dimensional unit-norm vectors', async () => {
    const solidPath = join(fixtureDir, 'solid.png')
    const otherPath = join(fixtureDir, 'other.png')
    const sinePath = join(fixtureDir, 'sine.wav')
    const otherWavPath = join(fixtureDir, 'other.wav')
    writeFileSync(solidPath, solidPng(200, 0, 80))
    writeFileSync(otherPath, checkerPng(40, 220, 60))
    writeFileSync(sinePath, sineWav(440))
    writeFileSync(otherWavPath, sineWav(880))

    const instance = await activateExtension(extension, context())
    const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await provider.load({ assets: mediaAssets(), signal: new AbortController().signal })
    const embed = async (kind: string, path: string) => {
      const result = await provider.invoke({
        implementationId: 'embeddinggemma2-onnx',
        input: { items: [{ id: 'm', parts: [{ kind, path }] }], purpose: 'similarity', role: 'symmetric' },
        context: invocation(),
      }) as { vectors: Array<{ values: number[]; dimensions: number; normalized: boolean }> }
      return result.vectors[0]!
    }
    const image = await embed('image', solidPath)
    const audio = await embed('audio', sinePath)
    for (const vector of [image, audio]) {
      assert.equal(vector.values.length, 768)
      assert.equal(vector.dimensions, 768)
      assert.equal(vector.normalized, true)
      const norm = Math.sqrt(vector.values.reduce((acc, value) => acc + value * value, 0))
      assert.ok(Math.abs(norm - 1) < 1e-4, 'the media embedding must be unit-norm (MOD-03/04)')
      assert.ok(vector.values.every(Number.isFinite), 'every element must be finite')
    }

    // Identical-vs-different sanity IN the real media space: the same fixture
    // scores ≈ 1; a different fixture scores measurably lower.
    const pair = async (kind: string, left: string, right: string) => {
      const result = await provider.invoke({
        implementationId: 'embeddinggemma2-similarity',
        input: { left: { id: 'l', parts: [{ kind, path: left }] }, right: { id: 'r', parts: [{ kind, path: right }] } },
        context: invocation(),
      }) as { score: number }
      return result.score
    }
    const imageIdentical = await pair('image', solidPath, solidPath)
    const imageDifferent = await pair('image', solidPath, otherPath)
    assert.ok(imageIdentical > 0.99, `an identical image pair must score ≈ 1.0, saw ${imageIdentical}`)
    assert.ok(imageDifferent < imageIdentical - 0.1, `different images must score lower: ${imageDifferent} vs ${imageIdentical}`)
    const audioIdentical = await pair('audio', sinePath, sinePath)
    assert.ok(audioIdentical > 0.99, `an identical audio pair must score ≈ 1.0, saw ${audioIdentical}`)
    // The different-CONTENT audio pair is SYSTEM-SYNTHESIZED SPEECH (the same
    // System.Speech utterances the qualification uses): two pure tones cluster in
    // this space (440 vs 880 Hz measured ~0.96), so the margin is judged on real
    // content, not on the tones.
    const speech = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(process.cwd(), 'scripts', 'synthesize-voz-utterances.ps1'), '-OutDir', fixtureDir,
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(speech.status, 0, `utterance synthesis failed: ${speech.stderr ?? speech.stdout}`)
    const audioDifferent = await pair('audio', join(fixtureDir, 'german.wav'), join(fixtureDir, 'english.wav'))
    assert.ok(audioDifferent < audioIdentical - 0.1, `different speech content must score lower: ${audioDifferent} vs ${audioIdentical}`)

    // MOD-08 honesty: audio beyond the model's 11.2 s window is refused, not truncated.
    const longPath = join(fixtureDir, 'long.wav')
    const longFrames = Math.floor(16000 * 15)
    const longData = Buffer.alloc(longFrames * 2) // 15 s of silence
    const longHeader = Buffer.alloc(44)
    longHeader.write('RIFF', 0)
    longHeader.writeUInt32LE(36 + longData.byteLength, 4)
    longHeader.write('WAVE', 8)
    longHeader.write('fmt ', 12)
    longHeader.writeUInt32LE(16, 16)
    longHeader.writeUInt16LE(1, 20)
    longHeader.writeUInt16LE(1, 22)
    longHeader.writeUInt32LE(16000, 24)
    longHeader.writeUInt32LE(16000 * 2, 28)
    longHeader.writeUInt16LE(2, 32)
    longHeader.writeUInt16LE(16, 34)
    longHeader.write('data', 36)
    longHeader.writeUInt32LE(longData.byteLength, 40)
    writeFileSync(longPath, Buffer.concat([longHeader, longData]))
    await assert.rejects(
      provider.invoke({
        implementationId: 'embeddinggemma2-onnx',
        input: { items: [{ id: 'm', parts: [{ kind: 'audio', path: longPath }] }], purpose: 'similarity', role: 'symmetric' },
        context: invocation(),
      }),
      /over the 11\.2 s limit/,
    )
    await instance.dispose('test end')
  })

  it('MOD-02 cross-group isolation: an AUDIO call loads text+audio only, an IMAGE call text+vision only', async () => {
    // The fused model always needs the text backbone; what must NEVER happen is a
    // media call demanding the OTHER modality's group. An audio call with the
    // vision group absent must succeed, and an image call with the audio group
    // absent must succeed — neither may fetch or require the sibling encoder.
    const sinePath = join(fixtureDir, 'sine.wav')
    writeFileSync(sinePath, sineWav(440))
    const solidPath = join(fixtureDir, 'solid.png')
    writeFileSync(solidPath, solidPng(200, 0, 80))
    const assetsFor = (groups: string[]) => ({
      get: (assetId: string) => (groups.includes(assetId) ? { path: CACHE_DIR, digest: `sha256:${REVISION}` } : undefined),
      assetIds: groups,
    })

    const audioOnly = await activateExtension(extension, context())
    const audioProvider = await audioOnly.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await audioProvider.load({ assets: assetsFor(['text-backbone', 'audio-encoder']), signal: new AbortController().signal })
    const audioResult = await audioProvider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: { items: [{ id: 'a', parts: [{ kind: 'audio', path: sinePath }] }], purpose: 'similarity', role: 'symmetric' },
      context: invocation(),
    }) as { vectors: Array<{ values: number[] }> }
    assert.equal(audioResult.vectors[0]?.values.length, 768, 'an audio call must embed without the vision group')
    await audioOnly.dispose('test end')

    const imageOnly = await activateExtension(extension, context())
    const imageProvider = await imageOnly.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await imageProvider.load({ assets: assetsFor(['text-backbone', 'vision-encoder']), signal: new AbortController().signal })
    const imageResult = await imageProvider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: { items: [{ id: 'i', parts: [{ kind: 'image', path: solidPath }] }], purpose: 'similarity', role: 'symmetric' },
      context: invocation(),
    }) as { vectors: Array<{ values: number[] }> }
    assert.equal(imageResult.vectors[0]?.values.length, 768, 'an image call must embed without the audio group')
    await imageOnly.dispose('test end')
  })

  it('MOD-02 cross-group isolation: a VIDEO call loads text+vision only, never audio (H4)', async () => {
    // The fused video path rides the VISION group (the same exported encoder
    // graph serves the per-frame video grid). A video call with {text, vision}
    // must embed; a video call with {text, audio} only must refuse naming the
    // VISION group — the audio group is never demanded by a video part.
    const avi = join(fixtureDir, 'tiny.avi')
    writeFileSync(avi, miniAvi([{ red: 200, green: 0, blue: 80 }, { red: 40, green: 220, blue: 60 }]))
    const assetsFor = (groups: string[]) => ({
      get: (assetId: string) => (groups.includes(assetId) ? { path: CACHE_DIR, digest: `sha256:${REVISION}` } : undefined),
      assetIds: groups,
    })

    const withVision = await activateExtension(extension, context())
    const visionProvider = await withVision.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await visionProvider.load({ assets: assetsFor(['text-backbone', 'vision-encoder']), signal: new AbortController().signal })
    const videoResult = await visionProvider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: { items: [{ id: 'v', parts: [{ kind: 'video', path: avi }] }], purpose: 'similarity', role: 'symmetric' },
      context: invocation(),
    }) as { vectors: Array<{ values: number[]; normalized: boolean }>; processing: Array<{ sampledVideoFrames: number[] }> }
    const videoVector = videoResult.vectors[0]!
    assert.equal(videoVector.values.length, 768, 'a video call with text+vision must embed through the fused video path')
    assert.equal(videoVector.normalized, true)
    assert.ok(
      videoResult.processing[0]!.sampledVideoFrames.length >= 1,
      'the sampled-frame timestamps must be returned honestly',
    )
    await withVision.dispose('test end')

    const withoutVision = await activateExtension(extension, context())
    const audioOnlyProvider = await withoutVision.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    await audioOnlyProvider.load({ assets: assetsFor(['text-backbone', 'audio-encoder']), signal: new AbortController().signal })
    await assert.rejects(
      audioOnlyProvider.invoke({
        implementationId: 'embeddinggemma2-onnx',
        input: { items: [{ id: 'v', parts: [{ kind: 'video', path: avi }] }], purpose: 'similarity', role: 'symmetric' },
        context: invocation(),
      }),
      /"vision-encoder" asset group was not prepared/,
      'a video call without the vision group must refuse by naming the group, never touch audio',
    )
    await withoutVision.dispose('test end')
  })
})
