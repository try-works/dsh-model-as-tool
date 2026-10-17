import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { activateExtension } from '@try-works/tool-mode-extension-sdk'
import extension from '../src/index.ts'
import { MEDIA_LIMITS, sampleVideoFrames } from '../src/media.ts'

/** A host-issued context (the same shape embedding-real uses). */
function context(): { extensionId: string; extensionVersion: string; activationGeneration: number; storage: { directory: string; read: () => Promise<undefined>; write: () => Promise<void> }; logger: { log: () => void }; signal: AbortSignal; configuration: Record<string, never> } {
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

/** One little-endian 32-bit write. */
function le32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value >>> 0, offset)
}

/** One little-endian 16-bit write. */
function le16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value & 0xffff, offset)
}

/** A RIFF chunk (fourcc + payload, padded to even length). */
function riffChunk(id: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'ascii')
  le32(head, 4, payload.byteLength)
  const pad = payload.byteLength & 1
  return Buffer.concat([head, payload, pad === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

/**
 * Generate a minimal RIFF/AVI container with UNCOMPRESSED DIB frames — the one
 * container+codec the bounded sampler implements.
 *
 * The layout is the spec-level one: `hdrl` LIST with `avih` (frame count, rate,
 * dimensions) and a `strl` LIST with `strh`/`strf` (BITMAPINFOHEADER,
 * biCompression 0), then a `movi` LIST of `00db` chunks holding bottom-up BGR24
 * rows padded to 4-byte boundaries. No index chunk: the sampler walks movi
 * sizes, which is the point of the bounds tests.
 */
function uncompressedAvi(options: {
  readonly frames: ReadonlyArray<{ readonly red: number; readonly green: number; readonly blue: number }>
  readonly width?: number
  readonly height?: number
  readonly fps?: number
  /** Override the declared frame count in avih (for the disagreement test). */
  readonly declaredFrames?: number
  /** Override the declared compression (for the codec-refusal test). */
  readonly compression?: number
  /** Override the declared bits per pixel (for the format-refusal test). */
  readonly bitsPerPixel?: number
}): Buffer {
  const width = options.width ?? 32
  const height = options.height ?? 24
  const fps = options.fps ?? 2
  const stride = Math.ceil((width * 3) / 4) * 4
  const frameBytes = stride * height
  const bitsPerPixel = options.bitsPerPixel ?? 24
  const compression = options.compression ?? 0
  const frameCount = options.frames.length

  const moviParts: Buffer[] = []
  for (const frame of options.frames) {
    const rows = Buffer.alloc(frameBytes)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // Bottom-up: row y of the buffer is the image row (height-1-y).
        const rowBase = y * stride
        rows.writeUInt8(frame.blue, rowBase + x * 3)
        rows.writeUInt8(frame.green, rowBase + x * 3 + 1)
        rows.writeUInt8(frame.red, rowBase + x * 3 + 2)
      }
    }
    moviParts.push(riffChunk('00db', rows))
  }

  const avih = Buffer.alloc(40)
  le32(avih, 0, Math.round(1_000_000 / fps)) // dwMicroSecPerFrame
  le32(avih, 16, options.declaredFrames ?? frameCount) // dwTotalFrames
  le32(avih, 32, width) // dwWidth
  le32(avih, 36, height) // dwHeight

  const strh = Buffer.alloc(56)
  strh.write('vids', 0, 'ascii') // fccType
  strh.write('DIB ', 4, 'ascii') // fccHandler
  le32(strh, 20, frameCount) // dwLength
  le32(strh, 24, Math.round(1_000_000 / fps)) // dwScale

  const strf = Buffer.alloc(40)
  le32(strf, 0, 40) // biSize
  le32(strf, 4, width) // biWidth
  le32(strf, 8, height) // biHeight
  le16(strf, 12, 1) // biPlanes
  le16(strf, 14, bitsPerPixel) // biBitCount
  le32(strf, 16, compression) // biCompression

  const hdrl = riffChunk('LIST', Buffer.concat([
    Buffer.from('hdrl', 'ascii'),
    riffChunk('avih', avih),
    riffChunk('LIST', Buffer.concat([
      Buffer.from('strl', 'ascii'),
      riffChunk('strh', strh),
      riffChunk('strf', strf),
    ])),
  ]))
  const movi = riffChunk('LIST', Buffer.concat([Buffer.from('movi', 'ascii'), ...moviParts]))
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('AVI ', 'ascii'),
    hdrl,
    movi,
  ])
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'eg2-video-'))
after(() => rmSync(fixtureDir, { recursive: true, force: true }))

test('the bounded AVI sampler parses metadata and extracts the pinned 1 fps samples', async () => {
  const path = join(fixtureDir, 'tiny.avi')
  const colors = [
    { red: 200, green: 0, blue: 80 },
    { red: 40, green: 220, blue: 60 },
    { red: 10, green: 10, blue: 240 },
    { red: 240, green: 200, blue: 10 },
  ]
  writeFileSync(path, uncompressedAvi({ frames: colors, width: 32, height: 24, fps: 2 }))

  const parsed = await sampleVideoFrames(path)
  assert.equal(parsed.width, 32)
  assert.equal(parsed.height, 24)
  assert.equal(parsed.frames, 4)
  assert.equal(parsed.declaredFps, 2)
  // 1 fps over 4 frames at 2 fps: frames 0, 2.
  assert.deepEqual(parsed.samples.map(sample => sample.index), [0, 2])
  assert.deepEqual(parsed.sampleTimestamps, [0, 1])
  for (const sample of parsed.samples) {
    // BGR24 with the declared stride; frame 0 is the first solid color.
    assert.equal(sample.bytes.byteLength, Math.ceil((32 * 3) / 4) * 4 * 24)
    assert.equal(sample.bytes.readUInt8(0), colors[sample.index]!.blue)
    assert.equal(sample.bytes.readUInt8(1), colors[sample.index]!.green)
    assert.equal(sample.bytes.readUInt8(2), colors[sample.index]!.red)
  }
})

test('the sampler refuses a COMPRESSED stream by name (no half-read)', async () => {
  const path = join(fixtureDir, 'compressed.avi')
  writeFileSync(path, uncompressedAvi({ frames: [{ red: 1, green: 2, blue: 3 }], compression: 0x34363248 })) // 'H264'
  await assert.rejects(sampleVideoFrames(path), /compressed \(biCompression .*\); only uncompressed DIB frames are implemented/)
})

test('the sampler refuses a non-BGR24 format by name', async () => {
  const path = join(fixtureDir, 'bpp.avi')
  writeFileSync(path, uncompressedAvi({ frames: [{ red: 1, green: 2, blue: 3 }], bitsPerPixel: 32 }))
  await assert.rejects(sampleVideoFrames(path), /32-bit frames are not BGR24; refused by name/)
})

test('the sampler refuses a frame whose bytes disagree with the declared layout', async () => {
  const path = join(fixtureDir, 'short-frame.avi')
  const good = uncompressedAvi({ frames: [{ red: 1, green: 2, blue: 3 }], width: 32, height: 24 })
  // Corrupt the movi frame's SIZE word (the 4 bytes before the single frame's
  // payload): -1 byte, so the declared layout mismatch fires on the sampled frame.
  const stride = Math.ceil((32 * 3) / 4) * 4
  const frameBytes = stride * 24
  const sizeOffset = good.byteLength - frameBytes - 4
  good.writeUInt32LE(good.readUInt32LE(sizeOffset) - 1, sizeOffset)
  writeFileSync(path, good)
  await assert.rejects(sampleVideoFrames(path), /not the \d+ its .* BGR24 layout requires/)
})

test('the sampler enforces the source-size and dimension caps before allocation', async () => {
  const big = join(fixtureDir, 'big-dim.avi')
  writeFileSync(big, uncompressedAvi({ frames: [{ red: 1, green: 2, blue: 3 }], width: MEDIA_LIMITS.maxVideoDimension + 1, height: 8 }))
  await assert.rejects(sampleVideoFrames(big), /exceeds the .*-pixel dimension cap/)

  const oversized = join(fixtureDir, 'oversized.avi')
  // A header-sized file padded past the cap: the readBounded stat refuses it first.
  const pad = Buffer.alloc(MEDIA_LIMITS.maxVideoBytes + 1)
  writeFileSync(oversized, pad)
  await assert.rejects(sampleVideoFrames(oversized), /over the .*-byte limit/)
})

test('a video PART now VALIDATES (the fused path exists); an unloaded provider refuses NOT_PREPARED', async () => {
  const videoPath = join(fixtureDir, 'part.avi')
  writeFileSync(videoPath, uncompressedAvi({ frames: [{ red: 200, green: 0, blue: 80 }] }))

  const instance = await activateExtension(extension, context() as never)
  const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
  // NO load() is called and NO assets are supplied: the part shape validates
  // (the fused video path exists now), and the honest refusal is the
  // NOT_PREPARED one — the deployment was never prepared, so nothing runs.
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: {
        items: [{ id: 'v', parts: [{ kind: 'video', path: videoPath }] }],
        purpose: 'similarity',
        role: 'symmetric',
        dimensions: 128,
      },
      context: {
        invocationId: 'video-refusal-test',
        signal: new AbortController().signal,
        limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
        resolvePath: (candidate: string) => candidate,
      },
    }),
    /the EmbeddingGemma 2 deployment is not prepared/,
  )
  // A malformed sampling shape is still refused at validation, before any work.
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-onnx',
      input: {
        items: [{
          id: 'v',
          parts: [{ kind: 'video', path: videoPath, sampling: { mode: 'uniform', maxFrames: 400 } }],
        }],
        purpose: 'similarity',
        role: 'symmetric',
        dimensions: 128,
      },
      context: {
        invocationId: 'video-refusal-test',
        signal: new AbortController().signal,
        limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
        resolvePath: (candidate: string) => candidate,
      },
    }),
    /"sampling" must be \{ mode: "uniform", maxFrames: 1\.\.32 \}/,
  )
  await instance.dispose('test end')
})

test('the sampled frame bytes are deterministic and match the independent layout', async () => {
  const path = join(fixtureDir, 'digest.avi')
  const colors = [{ red: 5, green: 6, blue: 7 }, { red: 8, green: 9, blue: 10 }]
  writeFileSync(path, uncompressedAvi({ frames: colors, fps: 1, width: 32, height: 24 }))
  const parsed = await sampleVideoFrames(path)
  // 1 fps over 2 frames at 1 fps: both frames sampled, each once.
  assert.equal(parsed.samples.length, 2)
  // The expected first-frame bytes, built INDEPENDENTLY of the parser: bottom-up
  // BGR24 rows padded to the 4-byte stride for a 32x24 solid frame.
  const expected = Buffer.alloc(Math.ceil((32 * 3) / 4) * 4 * 24)
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const base = y * Math.ceil((32 * 3) / 4) * 4
      expected.writeUInt8(colors[0]!.blue, base + x * 3)
      expected.writeUInt8(colors[0]!.green, base + x * 3 + 1)
      expected.writeUInt8(colors[0]!.red, base + x * 3 + 2)
    }
  }
  assert.equal(
    createHash('sha256').update(parsed.samples[0]!.bytes).digest('hex'),
    createHash('sha256').update(expected).digest('hex'),
    'the extracted frame must equal the independent BGR24 layout',
  )
  const again = await sampleVideoFrames(path)
  assert.deepEqual(
    again.samples.map(sample => createHash('sha256').update(sample.bytes).digest('hex')),
    parsed.samples.map(sample => createHash('sha256').update(sample.bytes).digest('hex')),
    'the sampler must be deterministic',
  )
})
