/**
 * TASK-115: the mapping must emit EXACTLY the declared contract
 * (schemas/lang-detect.output.json, additionalProperties: false). This would
 * have caught the live `isTooCloseToCall` vs `tooCloseToCall` mismatch.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'

import { mapLanguageDetection } from '../src/index.ts'

const schema = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'extension-desert-ant-tongue', 'schemas', 'lang-detect.output.json'), 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ strict: false })
const validate = ajv.compile(schema)

test('the mapped detection satisfies the declared lang_detect output schema', () => {
  const mapped = mapLanguageDetection({
    language: 'en',
    reliability: 'likely',
    isTooCloseToCall: true,
    candidates: [
      { language: 'en', probability: 0.62 },
      { language: 'es', probability: 0.33 },
      { language: 'fr', probability: 0.05 },
    ],
  }, 3)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  // The contract field name, never the native one.
  assert.equal(mapped['tooCloseToCall'], true)
  assert.equal('isTooCloseToCall' in mapped, false)
})

test('the fallbacks (absent native fields) also satisfy the schema', () => {
  const mapped = mapLanguageDetection({}, 3)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  assert.equal(mapped['language'], null)
  assert.equal(mapped['reliability'], 'unknown')
  assert.equal(mapped['tooCloseToCall'], false)
  assert.deepEqual(mapped['candidates'], [])
})

test('the top bound clips the candidates', () => {
  const mapped = mapLanguageDetection({
    candidates: [
      { language: 'a', probability: 0.5 },
      { language: 'b', probability: 0.3 },
      { language: 'c', probability: 0.2 },
    ],
  }, 2)
  assert.equal(validate(mapped), true, ajv.errorsText(validate.errors))
  assert.equal((mapped['candidates'] as unknown[]).length, 2)
})
