/**
 * The RIFF/WAVE parser regression tests.
 *
 * Each case builds a real byte-level fixture, including the exact System.Speech
 * layout that broke the old fixed-offset parser (an 18-byte `fmt ` chunk), so
 * the duration measurement cannot silently regress to reading mid-header
 * garbage. A real-file case parses a surviving synthesized WAV when one exists
 * under docs/tool-mode/qualification and skips with the reason otherwise.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseWave } from './voz-wav.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

const dirs = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'voz-wav-test-'))
  dirs.push(dir)
  return dir
}

/**
 * Build a RIFF/WAVE file from parts.
 * @param {object} o - { fmt: Buffer, chunks: Array<{id, body}> }
 * Every chunk is written with its real size; odd-sized bodies get the pad byte.
 */
function buildWave({ fmt, chunks }) {
  const parts = []
  let riffSize = 4 // 'WAVE'
  for (const chunk of [{ id: 'fmt ', body: fmt }, ...chunks]) {
    const padded = chunk.body.length + (chunk.body.length & 1)
    riffSize += 8 + padded
    parts.push(Buffer.from(chunk.id, 'ascii'), sizeOf(chunk.body.length), chunk.body)
    if (chunk.body.length & 1) parts.push(Buffer.alloc(1))
  }
  const riff = Buffer.alloc(4)
  riff.writeUInt32LE(riffSize, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riff, Buffer.from('WAVE', 'ascii'), ...parts])
}

function sizeOf(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

/** A 16-byte fmt chunk: PCM, mono, 16 kHz, 16-bit (byteRate 32000). */
function fmt16() {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(16000, 4)
  fmt.writeUInt32LE(32000, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  return fmt
}

/** The EXACT System.Speech layout: 18-byte fmt (cbSize 0), 22050 Hz mono 16-bit. */
function fmt18SystemSpeech() {
  const fmt = Buffer.alloc(18)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(22050, 4)
  fmt.writeUInt32LE(44100, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  fmt.writeUInt16LE(0, 16)
  return fmt
}

function dataChunk(bytes) {
  return { id: 'data', body: bytes }
}

describe('voz-wav: the chunk-walking RIFF parser', () => {
  it('parses a canonical 16-byte-fmt WAV', () => {
    const data = Buffer.alloc(32000)
    const wave = parseWave(buildWave({ fmt: fmt16(), chunks: [dataChunk(data)] }))
    assert.equal(wave.sampleRate, 16000)
    assert.equal(wave.byteRate, 32000)
    assert.equal(wave.dataBytes, 32000)
    assert.equal(wave.durationSeconds, 1)
  })

  it('parses the EXACT System.Speech layout (18-byte fmt, 46-byte header)', () => {
    // The real english.wav numbers: 148790 data bytes at 44100 B/s = 3.3739 s.
    const data = Buffer.alloc(148790)
    const wave = parseWave(buildWave({ fmt: fmt18SystemSpeech(), chunks: [dataChunk(data)] }))
    assert.equal(wave.fmtBytes, 18)
    assert.equal(wave.sampleRate, 22050)
    assert.equal(wave.byteRate, 44100)
    assert.ok(Math.abs(wave.durationSeconds - 3.373922902494331) < 1e-9, `duration ${wave.durationSeconds}`)
  })

  it('skips a LIST/INFO chunk (odd-sized, with its pad byte) between fmt and data', () => {
    const info = Buffer.from('IENGthis is odd') // 12 bytes → padded to 13
    const data = Buffer.alloc(32000)
    const wave = parseWave(buildWave({ fmt: fmt16(), chunks: [{ id: 'LIST', body: info }, dataChunk(data)] }))
    assert.equal(wave.durationSeconds, 1)
  })

  it('sums MULTIPLE data chunks', () => {
    const wave = parseWave(buildWave({
      fmt: fmt16(),
      chunks: [dataChunk(Buffer.alloc(16000)), dataChunk(Buffer.alloc(16000))],
    }))
    assert.equal(wave.dataBytes, 32000)
    assert.equal(wave.dataRanges.length, 2)
    assert.equal(wave.durationSeconds, 1)
  })

  it('rejects a chunk that declares bytes past the end of the file', () => {
    const bytes = buildWave({ fmt: fmt16(), chunks: [dataChunk(Buffer.alloc(8000))] })
    // Corrupt the data chunk's SIZE field (header: RIFF 12 + fmt 24 + 'data' 4 → size at offset 40).
    bytes.writeUInt32LE(999999, 40)
    assert.throws(() => parseWave(bytes), /past the end of the file/)
  })

  it('rejects a file whose RIFF size disagrees with its length', () => {
    const bytes = buildWave({ fmt: fmt16(), chunks: [dataChunk(Buffer.alloc(8000))] })
    bytes.writeUInt32LE(bytes.length + 100, 4)
    assert.throws(() => parseWave(bytes), /size field declares/)
  })

  it('rejects the malformed variants: no fmt, no data, short fmt, zero byte rate, non-PCM', () => {
    assert.throws(() => parseWave(buildWave({ fmt: fmt16(), chunks: [] })), /no data chunk/)
    const noFmt = buildWave({ fmt: fmt16(), chunks: [dataChunk(Buffer.alloc(8000))] })
    noFmt.write('junk', 12)
    assert.throws(() => parseWave(noFmt), /no fmt chunk|not a RIFF/)
    const shortFmt = fmt16().subarray(0, 14)
    assert.throws(() => parseWave(buildWave({ fmt: shortFmt, chunks: [dataChunk(Buffer.alloc(8000))] })), /needs at least 16/)
    const zeroRate = fmt16()
    zeroRate.writeUInt32LE(0, 8)
    assert.throws(() => parseWave(buildWave({ fmt: zeroRate, chunks: [dataChunk(Buffer.alloc(8000))] })), /zero byte rate/)
    const notPcm = fmt16()
    notPcm.writeUInt16LE(3, 0)
    assert.throws(() => parseWave(buildWave({ fmt: notPcm, chunks: [dataChunk(Buffer.alloc(8000))] })), /not PCM/)
  })

  it('rejects a truncated header outright', () => {
    assert.throws(() => parseWave(Buffer.from('RIFF\x04\x00\x00')), /header is truncated|not a RIFF/)
  })

  it('measures a REAL surviving System.Speech WAV when one exists', (t) => {
    const qualification = join(REPO_ROOT, 'docs', 'tool-mode', 'qualification')
    const dirsHere = existsSync(qualification)
      ? readdirSync(qualification).filter(name => name.startsWith('.voz-wavs-'))
      : []
    const real = dirsHere
      .map(name => join(qualification, name, 'english.wav'))
      .find(path => existsSync(path))
    if (real === undefined) {
      t.skip('no surviving synthesized english.wav under docs/tool-mode/qualification')
      return
    }
    const wave = parseWave(readFileSync(real))
    assert.equal(wave.fmtBytes, 18, 'System.Speech must emit the 18-byte fmt this regression guards')
    assert.equal(wave.sampleRate, 22050)
    assert.ok(
      Math.abs(wave.durationSeconds - 3.37) < 0.02,
      `the real utterance must measure ~3.37 s, saw ${wave.durationSeconds}`,
    )
    assert.ok(wave.durationSeconds < 10, 'the old fixed-offset parser read ~26330 s here; that regression must not return')
  })
})
