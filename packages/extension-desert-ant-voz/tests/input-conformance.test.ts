/**
 * TASK-120: the CONTRACT input mapping conformance. The host validates the
 * caller's input against schemas/stt-transcribe.input.json and hands THAT
 * document to the handler — the handler must read `audio.path` (never the
 * native audio_path), and `timestamps: "word"` must produce words or an
 * error. This test would have caught the live audio_path failure offline.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'

import { audioPathOf, includeWordsFor } from '../src/index.ts'

const schema = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'extension-desert-ant-voz', 'schemas', 'stt-transcribe.input.json'), 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ strict: false })
const validate = ajv.compile(schema)

test('the handler consumes the CONTRACT input shape (audio.path), never the native audio_path', () => {
  const input = {
    audio: { path: 'C:/recordings/clip.wav', sampleRateHz: 16000, channels: 1 },
    language: 'en',
    timestamps: 'none',
  }
  assert.equal(validate(input), true, ajv.errorsText(validate.errors))
  assert.equal(audioPathOf(input), 'C:/recordings/clip.wav')
  // The native field is NOT part of the contract and must not be consulted.
  const nativeOnly = { audio_path: 'C:/nope.wav' }
  assert.equal(validate(nativeOnly), false, 'the schema refuses the native shape before the handler sees it')
  assert.throws(() => audioPathOf(nativeOnly), /audio\.path/)
})

test('timestamps maps: "word" includes words, "none" omits, anything else refuses', () => {
  assert.equal(includeWordsFor({ timestamps: 'word' }), true)
  assert.equal(includeWordsFor({ timestamps: 'none' }), false)
  assert.equal(includeWordsFor({}), false, 'the default is no word timestamps')
  assert.throws(() => includeWordsFor({ timestamps: 'sentence' }), /unsupported "timestamps"/)
})

test('a valid contract input validates and every required field is honored', () => {
  const input = {
    audio: { path: 'C:/recording.wav' },
    language: 'en',
    timestamps: 'word',
  }
  assert.equal(validate(input), true, ajv.errorsText(validate.errors))
  assert.equal(audioPathOf(input), 'C:/recording.wav')
  assert.equal(includeWordsFor(input), true)
  // An invalid input is refused BY THE SCHEMA, not by the handler.
  const invalid = { audio: { path: '' }, language: 'x', timestamps: 'maybe' }
  assert.equal(validate(invalid), false)
})
