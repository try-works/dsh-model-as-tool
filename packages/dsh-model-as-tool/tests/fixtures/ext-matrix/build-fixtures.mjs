/**
 * Deterministic builders for the extension-matrix binary fixtures (task-111).
 *
 * The matrix needs two small binary inputs that a test suite can commit and
 * trust:
 *
 * - a 16 kHz mono 16-bit PCM WAV, so `stt_transcribe` is exercised through a
 *   real RIFF header and a real sample rate rather than a promised one; and
 * - a small PNG whose VISIBLE content (a red rectangle and a blue circle on a
 *   white field) is what `image.describe` must talk about. It deliberately has
 *   no text in it, so a description has to name what is there rather than
 *   transcribe a caption.
 *
 * WHAT THE AUDIO CAN AND CANNOT PROVE. The tone is synthesized, not speech:
 * a 2 s tone proves the pipeline decodes a valid 16 kHz mono PCM WAV, returns
 * the declared shape and reports coverage bounded by the real duration. It
 * CANNOT prove word accuracy, language detection or punctuation, and no test
 * in this repository claims that. A separate 1 s SILENCE file proves the honest
 * empty result offline: silence must not be invented into words.
 *
 * Everything is deterministic: same bytes on every run and every platform (no
 * dates, no randomness, no locale-dependent formatting). `scripts/lib/` and the
 * tests import the builders to assert the COMMITTED assets still equal what the
 * builder produces, so the checked-in bytes cannot silently drift.
 *
 * @module tests/fixtures/ext-matrix/build-fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

/** The fixture root this module builds into. */
const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC-32 (the PNG chunk checksum), computed without a dependency. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 of a buffer, as PNG stores it in every chunk. */
export function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** Build one PNG chunk: length, type, body, CRC over type+body. */
function pngChunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 0)
  return Buffer.concat([length, typeBytes, body, checksum])
}

/**
 * The canonical tiny canvas: 96x64 RGB.
 *
 * White background, a red square on the left and a blue circle on the right.
 * The shapes and colours are the visible facts a description has to mention;
 * the filename is deliberately not descriptive of them, which is what lets a
 * test reject a description that merely echoes the path.
 * @returns {Buffer} a valid 8-bit RGB PNG.
 */
export function buildCanvasPng() {
  const width = 96
  const height = 64
  const pixels = Buffer.alloc(width * height * 3)
  /** Paint one pixel; coordinates are validated by the callers below. */
  const paint = (x, y, red, green, blue) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = (y * width + x) * 3
    pixels[offset] = red
    pixels[offset + 1] = green
    pixels[offset + 2] = blue
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) paint(x, y, 0xff, 0xff, 0xff)
  }
  // A red square, 30x30, at (8, 12).
  for (let y = 12; y < 42; y += 1) {
    for (let x = 8; x < 38; x += 1) paint(x, y, 0xd9, 0x2b, 0x2b)
  }
  // A blue filled circle, centre (68, 32), radius 17.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - 68
      const dy = y - 32
      if (dx * dx + dy * dy <= 17 * 17) paint(x, y, 0x2b, 0x5c, 0xd9)
    }
  }
  // Scanlines: filter type 0 (None), then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0
    pixels.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour RGB
  header[10] = 0 // compression: deflate
  header[11] = 0 // filter: adaptive
  header[12] = 0 // interlace: none
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/** Build a canonical 44-byte-header RIFF/WAVE file around PCM sample bytes. */
function wavAround(sampleBytes, sampleRateHz = 16_000, channels = 1, bitsPerSample = 16) {
  const blockAlign = channels * (bitsPerSample / 8)
  const byteRate = sampleRateHz * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + sampleBytes.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRateHz, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(sampleBytes.length, 40)
  return Buffer.concat([header, sampleBytes])
}

/**
 * A deterministic 2 s "speech-like" tone at 16 kHz mono 16-bit PCM.
 *
 * A 180 Hz fundamental plus two harmonics, amplitude-modulated at a 4 Hz
 * syllable rate. It is deliberately a TONE, not speech: its purpose is to prove
 * the audio path decodes a real 16 kHz mono PCM WAV and reports the contract
 * shape, never to test word accuracy.
 * @returns {Buffer} the WAV bytes.
 */
export function buildToneWav() {
  const sampleRate = 16_000
  const seconds = 2
  const samples = sampleRate * seconds
  const bytes = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * time)
    const carrier =
      Math.sin(2 * Math.PI * 180 * time)
      + 0.5 * Math.sin(2 * Math.PI * 360 * time)
      + 0.25 * Math.sin(2 * Math.PI * 540 * time)
    const amplitude = 0.22 * envelope * (carrier / 1.75)
    const scaled = Math.max(-1, Math.min(1, amplitude))
    bytes.writeInt16LE(Math.round(scaled * 32_767), index * 2)
  }
  return wavAround(bytes)
}

/**
 * A deterministic 1 s SILENCE at 16 kHz mono 16-bit PCM.
 *
 * This is the honest empty-input fixture: a correct transcription of silence is
 * empty, so the offline validator test can assert that an empty transcript is
 * accepted and invented words are refused.
 * @returns {Buffer} the WAV bytes.
 */
export function buildSilenceWav() {
  const sampleRate = 16_000
  return wavAround(Buffer.alloc(sampleRate * 2), sampleRate, 1, 16)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The assets this module produces, as relative paths under the fixture root. */
export const BUILT_ASSETS = Object.freeze([
  { file: 'assets/tiny-canvas.png', build: buildCanvasPng, note: '96x64 RGB: red square left, blue circle right, white field' },
  { file: 'assets/tone-2s-16k-mono.wav', build: buildToneWav, note: '2.0 s synthetic tone, 16000 Hz, mono, 16-bit PCM' },
  { file: 'assets/silence-1s-16k-mono.wav', build: buildSilenceWav, note: '1.0 s silence, 16000 Hz, mono, 16-bit PCM' },
])

/** Write every asset and print its size. */
export function writeAssets(root = HERE) {
  mkdirSync(join(root, 'assets'), { recursive: true })
  for (const asset of BUILT_ASSETS) {
    const bytes = asset.build()
    writeFileSync(join(root, asset.file), bytes)
    process.stdout.write(`wrote ${asset.file} (${bytes.length} bytes) — ${asset.note}\n`)
  }
}

// Run the CLI only when this file is executed directly, not when a test imports
// the builders to pin the committed bytes.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeAssets(HERE)
}
