/**
 * TASK-115: the transcription mapping must emit EXACTLY the declared contract
 * (schemas/stt-transcribe.output.json, additionalProperties: false). This
 * would have caught the live {wordCount, realtimeFactor} extras + the missing
 * `coverage`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'

import { mapTranscription } from '../src/index.ts'

const schema = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'extension-desert-ant-voz', 'schemas', 'stt-transcribe.output.json'), 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ strict: false })
const validate = ajv.compile(schema)

test('the mapped transcription satisfies the declared stt_transcribe output schema', () => {
  const mapped = mapTranscription({
    text: 'hello world',
    words: [
      { text: 'hello', start: 0.1, end: 0.5 },
      { text: 'world', start: 0.6, end: 1.0 },
    ],
    realtimeFactor: 0.4,
  }, true)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  const coverage = mapped['coverage'] as Record<string, unknown>
  assert.equal(coverage['complete'], true)
  assert.equal(coverage['transcribedSeconds'], 0.9, 'last word end minus first word start')
  assert.equal(coverage['totalSeconds'], null)
  assert.deepEqual(mapped['words'], [
    { text: 'hello', start: 0.1, end: 0.5 },
    { text: 'world', start: 0.6, end: 1.0 },
  ])
  // The native extras are NOT in the schema and must be dropped.
  assert.equal('wordCount' in mapped, false)
  assert.equal('realtimeFactor' in mapped, false)
})

test('an empty transcript maps to a complete coverage of zero seconds', () => {
  const mapped = mapTranscription({ text: '' }, true)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  const coverage = mapped['coverage'] as Record<string, unknown>
  assert.equal(coverage['complete'], true, 'no truncation signal means a complete transcription')
  assert.equal(coverage['transcribedSeconds'], 0)
  assert.equal(coverage['totalSeconds'], null)
})

test('include_words false omits the words field entirely', () => {
  const mapped = mapTranscription({
    text: 'hello',
    words: [{ text: 'hello', start: 0, end: 0.4 }],
  }, false)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  assert.equal('words' in mapped, false)
})

test('the MAX_WORDS cap marks the coverage incomplete', () => {
  const words = Array.from({ length: 2001 }, (_, i) => ({ text: `w${i}`, start: i * 0.1, end: i * 0.1 + 0.05 }))
  const mapped = mapTranscription({ text: 'long', words }, true)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  const coverage = mapped['coverage'] as Record<string, unknown>
  assert.equal(coverage['complete'], false, 'truncation by MAX_WORDS must be reported')
})
