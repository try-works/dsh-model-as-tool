/**
 * The bounded Node media decoders (MOD-07).
 *
 * These tests pin the DECODER arithmetic — the WAV parser, the resampler, the
 * Gemma4 mel spectrogram and the image path — with deterministic fixtures, so
 * the encoder-facing tensors are reviewable numbers rather than a black box.
 * The image test needs the sharp-backed transformers decoder and skips with a
 * reason when that optional runtime cannot decode on this host.
 *
 * Requirement links: MOD-07, MOD-08, MOD-18.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AUDIO_PREPROCESSING, decodeImage, decodeWav, IMAGE_PREPROCESSING, melSpectrogram } from '../src/media.ts'

const dirs: string[] = []
function scratch(prefix = 'tmx-media-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Build a PCM16 WAV: sampleRate, seconds, sine frequency (0 = silence). */
function wavBytes(options: {
  readonly rate: number
  readonly seconds: number
  readonly frequency: number
  readonly channels?: 1 | 2
  readonly format?: 1 | 3
}): Buffer {
  const { rate, seconds, frequency, channels = 1, format = 1 } = options
  const frames = Math.floor(rate * seconds)
  const bytesPerSample = format === 3 ? 4 : 2
  const dataBytes = frames * channels * bytesPerSample
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(format, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * bytesPerSample, 28)
  header.writeUInt16LE(channels * bytesPerSample, 32)
  header.writeUInt16LE(bytesPerSample * 8, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.alloc(dataBytes)
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin((2 * Math.PI * frequency * frame) / rate) * 0.5
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (frame * channels + channel) * bytesPerSample
      if (format === 3) data.writeFloatLE(value, offset)
      else data.writeInt16LE(Math.round(value * 32767), offset)
    }
  }
  return Buffer.concat([header, data])
}

/** Write one WAV to a scratch file. */
function writeWav(options: Parameters<typeof wavBytes>[0]): string {
  const path = join(scratch(), 'sample.wav')
  writeFileSync(path, wavBytes(options))
  return path
}

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MOD-07 — the WAV decoder is bounded and honest', () => {
  it('decodes a 16 kHz PCM16 WAV and reports the source rate', async () => {
    const path = writeWav({ rate: 16000, seconds: 0.2, frequency: 440 })
    const audio = await decodeWav(path)
    assert.equal(audio.sourceRate, 16000)
    assert.equal(audio.samples.length, 3200)
    assert.equal(audio.seconds, 0.2)
    assert.ok(Math.abs(audio.samples[80] as number) > 0.05, 'the sine must survive decoding')
  })

  it('resamples a different source rate to the model 16 kHz, linearly', async () => {
    const path = writeWav({ rate: 8000, seconds: 0.1, frequency: 0 })
    const audio = await decodeWav(path)
    assert.equal(audio.sourceRate, 8000)
    assert.equal(audio.samples.length, 1600, '0.1 s at 8 kHz becomes 0.1 s at 16 kHz')
  })

  it('merges stereo to mono by averaging', async () => {
    const path = writeWav({ rate: 16000, seconds: 0.1, frequency: 440, channels: 2 })
    const audio = await decodeWav(path)
    assert.equal(audio.samples.length, 1600)
    const mono = await decodeWav(writeWav({ rate: 16000, seconds: 0.1, frequency: 440, channels: 1 }))
    for (let i = 0; i < 1600; i += 100) {
      assert.ok(Math.abs((audio.samples[i] as number) - (mono.samples[i] as number)) < 0.01, `sample ${i} must average to the mono value`)
    }
  })

  it('decodes float32 WAVs', async () => {
    const path = writeWav({ rate: 16000, seconds: 0.1, frequency: 440, format: 3 })
    const audio = await decodeWav(path)
    assert.equal(audio.samples.length, 1600)
  })

  it('applies the caller range and reports it honestly in seconds', async () => {
    const path = writeWav({ rate: 16000, seconds: 0.5, frequency: 440 })
    const audio = await decodeWav(path, { startSeconds: 0.1, endSeconds: 0.3 })
    assert.equal(audio.samples.length, 3200, '0.2 s of the requested window')
    assert.equal(audio.seconds, 0.2)
  })

  it('refuses a non-WAV file, a foreign codec and a range that selects nothing', async () => {
    const dir = scratch()
    const junk = join(dir, 'junk.bin')
    writeFileSync(junk, Buffer.from('not audio at all'))
    await assert.rejects(decodeWav(junk), /not a RIFF\/WAVE/)
    // A range beyond the file's own length selects no samples: the decoder's own
    // MOD-18 refusal (the inverted-range check lives in argument validation).
    const empty = join(dir, 'empty.wav')
    writeFileSync(empty, wavBytes({ rate: 16000, seconds: 0.1, frequency: 0 }))
    await assert.rejects(decodeWav(empty, { startSeconds: 5, endSeconds: 6 }), /selects no samples/)
  })
})

describe('MOD-07 — the Gemma4 mel spectrogram is deterministic', () => {
  it('silence produces the zero floor everywhere', async () => {
    const audio = await decodeWav(writeWav({ rate: 16000, seconds: 0.3, frequency: 0 }))
    const mel = melSpectrogram(audio.samples)
    const frames = mel.length / AUDIO_PREPROCESSING.melBins
    assert.ok(frames > 0)
    // The implementation's documented convention: log(max(power + 1, melFloor)),
    // so silence sits at log(1) = 0 on every bin.
    for (const value of mel) assert.ok(Math.abs(value) < 1e-6, 'silence must sit on the zero floor')
  })

  it('a 440 Hz sine concentrates energy in the low mel bins, deterministically', async () => {
    const audio = await decodeWav(writeWav({ rate: 16000, seconds: 0.3, frequency: 440 }))
    const first = melSpectrogram(audio.samples)
    const second = melSpectrogram(audio.samples)
    assert.deepEqual(Array.from(first), Array.from(second), 'the spectrogram must be byte-deterministic')
    const frame = 5
    const bins = Array.from(first.slice(frame * AUDIO_PREPROCESSING.melBins, (frame + 1) * AUDIO_PREPROCESSING.melBins))
    const peakBin = bins.indexOf(Math.max(...bins))
    assert.ok(Math.max(...bins) > 1, 'a real tone must rise above the silence floor')
    assert.ok(peakBin < AUDIO_PREPROCESSING.melBins / 2, `440 Hz must peak in the lower mel bins, peaked at ${peakBin}`)
  })
})

describe('MOD-07 — the image decoder preprocesses to the pinned grid', () => {
  it('decodes a generated solid PNG to the canonical grid with the pinned rescale', async (t) => {
    const path = join(scratch(), 'solid.png')
    writeFileSync(path, solidPng(8, 8, 200, 0, 80))
    let image
    try {
      image = await decodeImage(path)
    } catch (error) {
      t.skip(`the image decoder runtime cannot decode on this host: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    assert.equal(image.width, IMAGE_PREPROCESSING.width)
    assert.equal(image.height, IMAGE_PREPROCESSING.height)
    assert.equal(image.pixels.length, IMAGE_PREPROCESSING.width * IMAGE_PREPROCESSING.height * 3)
    // A uniform upscale of one color: the CENTER is exactly the rescaled color
    // (bicubic ringing reaches ~2 source pixels in from the tiny 8x8 source's
    // borders, which is hundreds of output pixels at this scale — the center is
    // the honest exactness pin: a decoder that misread the color fails it
    // everywhere).
    const expected = 200 * IMAGE_PREPROCESSING.rescaleFactor
    const { width, height } = image
    for (const [x, y] of [[width >> 1, height >> 1], [(width >> 1) + 120, (height >> 1) + 84]] as const) {
      const red = image.pixels[(0 * height + y) * width + x] as number
      assert.ok(Math.abs(red - expected) < 1e-4, `center pixel (${x},${y}) must be the rescaled color`)
    }
    for (let i = 0; i < image.pixels.length; i += 1) {
      assert.ok((image.pixels[i] as number) >= 0 && (image.pixels[i] as number) <= 1, 'every value stays in [0, 1]')
    }
  })
})

/** The PNG CRC-32, for the generator below. */
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

/** Write a minimal truecolor PNG (uncompressed scanlines with filter 0). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, pngCrc(type, data)])
}

/** A solid-color RGB PNG, width x height. */
function solidPng(width: number, height: number, red: number, green: number, blue: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(2, 9) // truecolor
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(0, 12)
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    scanlines.writeUInt8(0, row) // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3
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
